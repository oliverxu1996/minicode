import { describe, expect, test } from "bun:test"
import type { ModelLimits } from "@minicode/model"
import { contextBudget } from "@minicode/agent"
import type { ModelIdentity, RunEvent, RunFinishReason, RunSummary } from "@minicode/agent"
import {
  NO_RUN_DISPLAY,
  compactionNoticeText,
  contextDisplay,
  contextGauge,
  displayWidth,
  fitFooterRow,
  footerRowText,
  footerRows,
  formatTokens,
  reduceRunDisplay,
  resultLine,
  runStateLine,
  runSummaryLines,
  type FooterInput,
} from "./projection"

const MODEL: ModelIdentity = {
  id: "test-model",
  name: "Test Model",
  protocol: "openai",
  model: "provider-model",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
}

/** A 128k model: usable input budget = floor(128000 × 0.75) = 96000. */
const LIMITS: ModelLimits = { contextWindow: 128_000, maxOutputTokens: 8_192 }

const runStart = (): RunEvent => ({ type: "run_start", sessionId: "s1", runId: "r1", task: "t", model: MODEL })
const iteration = (n: number): RunEvent => ({ type: "iteration_start", iteration: n })
const responded = (inputTokens?: number, outputTokens?: number): RunEvent => ({
  type: "model_response",
  iteration: 1,
  finishReason: "tool_call",
  ...(inputTokens === undefined && outputTokens === undefined
    ? {}
    : { usage: { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) } }),
})
const compacted = (summarizedMessages: number, inputTokens?: number): RunEvent => ({
  type: "compaction",
  summarizedMessages,
  ...(inputTokens === undefined ? {} : { usage: { inputTokens } }),
})
const ended = (run: RunSummary): RunEvent => ({
  type: "run_end",
  runId: run.id,
  finishReason: run.finishReason ?? "stop",
  iterations: 1,
  run,
})

/** Strips SGR color codes so a rendered line can be measured. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

const baseInput: FooterInput = {
  cwd: "/home/dev/project",
  branch: "main",
  running: false,
  modelId: "deepseek-chat",
  limits: LIMITS,
  compactThresholdPct: 80,
  lastCallUsage: undefined,
  runRequests: 0,
  runUsage: undefined,
  lastRun: undefined,
  compactedMessages: undefined,
}

const row1Text = (o: Partial<FooterInput> = {}): string => footerRowText(footerRows({ ...baseInput, ...o }).row1)
const row2Text = (o: Partial<FooterInput> = {}): string => footerRowText(footerRows({ ...baseInput, ...o }).row2)

// ---------------------------------------------------------------------------
// 1 — the two scopes: last request vs whole run
// ---------------------------------------------------------------------------

describe("the last request and the whole run are never the same field", () => {
  test("the last call's usage is the latest call, and the run is a running sum", () => {
    let display = reduceRunDisplay(NO_RUN_DISPLAY, runStart())
    display = reduceRunDisplay(display, responded(100, 20))
    display = reduceRunDisplay(display, responded(300, 40))

    // The last call is the latest call, not a running sum.
    expect(display.lastCallUsage).toEqual({ inputTokens: 300, outputTokens: 40 })
    // The run is the accumulation of every call.
    expect(display.runUsage).toEqual({ inputTokens: 400, outputTokens: 60 })
    expect(display.runRequests).toBe(2)
  })

  test("a compaction call reaches the live run total and records the message count", () => {
    let display = reduceRunDisplay(NO_RUN_DISPLAY, runStart())
    display = reduceRunDisplay(display, responded(100, 20))
    display = reduceRunDisplay(display, compacted(12, 5000))

    expect(display.runUsage).toEqual({ inputTokens: 5100, outputTokens: 20 })
    expect(display.compactedMessages).toBe(12)
  })

  test("run_end replaces the live totals with the record and clears the compaction note", () => {
    let display = reduceRunDisplay(NO_RUN_DISPLAY, runStart())
    display = reduceRunDisplay(display, responded(100, 20))
    display = reduceRunDisplay(display, compacted(3, 40))
    display = reduceRunDisplay(display, ended({
      id: "r1", startedAt: 1, model: MODEL,
      usage: { inputTokens: 900, outputTokens: 120 }, modelCalls: 9, finishReason: "stop",
    }))

    expect(display.runUsage).toEqual({ inputTokens: 900, outputTokens: 120 })
    expect(display.runRequests).toBe(9)
    expect(display.lastRun?.id).toBe("r1")
    expect(display.compactedMessages).toBeUndefined()
    // The last-call reading is untouched by the run's totals.
    expect(display.lastCallUsage).toEqual({ inputTokens: 100, outputTokens: 20 })
  })

  test("a new run carries nothing over from the previous one", () => {
    let display = reduceRunDisplay(NO_RUN_DISPLAY, runStart())
    display = reduceRunDisplay(display, responded(300, 40))
    display = reduceRunDisplay(display, compacted(5, 10))
    display = reduceRunDisplay(display, ended({ id: "r1", startedAt: 1, model: MODEL, usage: { inputTokens: 900 }, modelCalls: 3 }))

    expect(reduceRunDisplay(display, runStart())).toEqual(NO_RUN_DISPLAY)
  })

  test("row 2 labels the request-scoped context apart from the cumulative run", () => {
    const text = row2Text({
      running: true,
      lastCallUsage: { inputTokens: 20_000, outputTokens: 900 },
      runRequests: 4,
      runUsage: { inputTokens: 70_000, outputTokens: 900 },
    })
    expect(text).toContain("Context ")
    expect(text).toContain("20k/96k usable")
    expect(text).toContain("run 4 req")
    expect(text).toContain("70k in / 900 out")
  })
})

// ---------------------------------------------------------------------------
// 2 — context is measured against MiniCode's usable input budget
// ---------------------------------------------------------------------------

describe("context is measured against the usable input budget", () => {
  test("the denominator is the 75% input budget, not the context window", () => {
    const budget = contextBudget(LIMITS).inputBudget
    expect(budget).toBe(96_000)
    expect(contextDisplay(budget, LIMITS, 80)?.percent).toBe(100)
    expect(contextDisplay(budget / 2, LIMITS, 80)?.percent).toBe(50)
    // Half the window is a different reading — the defect the contract names.
    expect(contextDisplay(LIMITS.contextWindow / 2, LIMITS, 80)?.percent).not.toBe(50)
  })

  test("over budget is flagged, and the percent is left free to exceed 100", () => {
    const over = contextDisplay(120_000, LIMITS, 80)
    expect(over?.overBudget).toBe(true)
    expect(over?.percent).toBe(125)
    expect(over?.capacity).toBe(96_000)
    expect(over?.used).toBe(120_000)
  })

  test("the threshold flag is inclusive of the configured share", () => {
    const threshold = Math.floor(contextBudget(LIMITS).inputBudget * 0.8) // 76800
    expect(contextDisplay(threshold - 1, LIMITS, 80)?.atThreshold).toBe(false)
    expect(contextDisplay(threshold, LIMITS, 80)?.atThreshold).toBe(true)
    expect(contextDisplay(96_000, LIMITS, 80)?.atThreshold).toBe(true)
    expect(contextDisplay(96_001, LIMITS, 80)?.atThreshold).toBe(false)
  })

  test("no reading is invented when an input is missing", () => {
    expect(contextDisplay(undefined, LIMITS, 80)).toBeUndefined()
    expect(contextDisplay(100, undefined, 80)).toBeUndefined()
    expect(contextDisplay(100, LIMITS, undefined)).toBeUndefined()
  })

  test("the gauge is clamped to its box at every value", () => {
    expect(contextGauge(0)).toBe("[░░░░░░░░░░░░]")
    expect(contextGauge(1)).toBe("[████████████]")
    expect(contextGauge(0.5)).toBe("[██████░░░░░░]")
    // Above budget never overflows the box.
    expect(contextGauge(1.25)).toBe("[████████████]")
    expect(contextGauge(-1)).toBe("[░░░░░░░░░░░░]")
  })

  test("the row shows used/capacity and the compaction rule, never the window", () => {
    const text = row2Text({ running: true, lastCallUsage: { inputTokens: 20_000 } })
    expect(text).toContain("20k/96k usable")
    expect(text).toContain("auto-compact at 80%")
    // 96000 (the budget) is present; 128k (the window) is not.
    expect(text).not.toContain("128k")
  })

  test("the reading follows the model in use", () => {
    const small: ModelLimits = { contextWindow: 1_000, maxOutputTokens: 250 }
    const large: ModelLimits = { contextWindow: 8_000, maxOutputTokens: 1_000 }
    expect(contextDisplay(750, small, 80)?.percent).toBe(100)
    expect(contextDisplay(750, large, 80)?.percent)
      .toBe(Math.round((750 / contextBudget(large).inputBudget) * 100))
    expect(contextDisplay(750, large, 80)?.percent).toBeLessThan(100)
  })
})

// ---------------------------------------------------------------------------
// 3 — above budget stays truthful
// ---------------------------------------------------------------------------

describe("an above-budget request is never an ordinary percentage", () => {
  test("row 2 says over budget, clamps the gauge, and shows no percent", () => {
    const text = row2Text({
      running: true,
      lastCallUsage: { inputTokens: 120_000, outputTokens: 2_100 },
      runRequests: 12,
      runUsage: { inputTokens: 640_000, outputTokens: 2_100 },
    })
    expect(text).toContain("120k/96k over budget")
    expect(text).not.toContain("usable")
    expect(text).not.toContain("125%")
    // The gauge is saturated, not overflowing.
    expect(text).toContain("[████████████]")
    expect(text).toContain("compacting…")
  })

  test("the context tone escalates: dim, then warn at threshold, then alert over budget", () => {
    const toneAt = (inputTokens: number): string =>
      footerRows({ ...baseInput, lastCallUsage: { inputTokens } }).row2.groups[0]!.parts[0]!.tone
    expect(toneAt(20_000)).toBe("dim")
    expect(toneAt(80_000)).toBe("warn") // >= 76800
    expect(toneAt(120_000)).toBe("alert")
  })
})

// ---------------------------------------------------------------------------
// 4 — model identity and the window
// ---------------------------------------------------------------------------

describe("the model's window is shown separately from the input budget", () => {
  test("row 1 carries the model id and its window", () => {
    expect(row1Text()).toBe("~/project (main) · Idle · deepseek-chat · 128k window")
  })

  test("a 1M model shows a 1M window while its budget remains its own", () => {
    const limits: ModelLimits = { contextWindow: 1_000_000, maxOutputTokens: 786_432 }
    const text = row1Text({ modelId: "deepseek-flash", limits })
    expect(text).toContain("deepseek-flash")
    expect(text).toContain("1M window")
    // The budget for this model is 750k, not the 96k of a 128k model.
    expect(row2Text({ limits, lastCallUsage: { inputTokens: 60_000 } })).toContain("60k/750k")
  })

  test("no model configured omits the model groups and the context field", () => {
    const text = row1Text({ modelId: undefined, limits: undefined })
    expect(text).toBe("~/project (main) · Idle")
    expect(row2Text({ modelId: undefined, limits: undefined })).toBe("no run yet")
  })

  test("a long model id is bounded", () => {
    const text = row1Text({ modelId: "a-very-long-model-configuration-key" })
    expect(text).toContain("a-very-long-mod…")
  })
})

// ---------------------------------------------------------------------------
// 5 — state handling
// ---------------------------------------------------------------------------

describe("the footer states", () => {
  test("idle with no run", () => {
    expect(row1Text()).toBe("~/project (main) · Idle · deepseek-chat · 128k window")
    expect(row2Text()).toBe("Context — · no run yet")
  })

  test("working, before the first response", () => {
    expect(row1Text({ running: true })).toContain("Working")
    expect(row1Text({ running: true })).toContain("Esc to interrupt")
    expect(row2Text({ running: true })).toBe("Context — · waiting for first response")
  })

  test("working, low context", () => {
    const text = row1Text({ running: true })
    expect(text).toBe("~/project (main) · Working · Esc to interrupt · deepseek-chat · 128k window")
  })

  test("completed shows the last run narrative and its totals", () => {
    const text = row2Text({
      running: false,
      lastCallUsage: { inputTokens: 22_000 },
      lastRun: { id: "r1", startedAt: 0, finishedAt: 72_000, model: MODEL, finishReason: "stop", modelCalls: 13 },
      runRequests: 13,
      runUsage: { inputTokens: 690_000, outputTokens: 2_400 },
    })
    expect(text).toContain("22k/96k usable")
    expect(text).toContain("last run finished in 1.2m")
    expect(text).toContain("13 req")
    expect(text).toContain("690k in / 2.4k out")
  })

  test("interrupted and error are distinguishable", () => {
    const run = (finishReason: RunFinishReason): RunSummary =>
      ({ id: "r1", startedAt: 0, finishedAt: 18_000, model: MODEL, finishReason, modelCalls: 4 })
    expect(row2Text({
      lastRun: run("aborted"), runRequests: 4, runUsage: { inputTokens: 95_000, outputTokens: 300 },
    })).toContain("last run interrupted after 18s")
    expect(row2Text({
      lastRun: run("error"), runRequests: 4, runUsage: { inputTokens: 95_000, outputTokens: 300 },
    })).toContain("last run ended in error")
  })

  test("after compilation the compaction note replaces the rule", () => {
    const text = row2Text({
      running: true,
      lastCallUsage: { inputTokens: 21_000 },
      compactedMessages: 12,
      runRequests: 13,
    })
    expect(text).toContain("21k/96k usable")
    expect(text).toContain("compacted 12 messages")
    expect(text).not.toContain("auto-compact at")
  })
})

// ---------------------------------------------------------------------------
// 6 — no step counter, no cryptic notation
// ---------------------------------------------------------------------------

describe("the footer exposes no internal loop counter", () => {
  test("no row ever shows a step", () => {
    for (const state of [
      { running: true },
      { running: false },
      { running: true, lastCallUsage: { inputTokens: 20_000 } },
    ]) {
      expect(row1Text(state)).not.toContain("step")
      expect(row2Text(state)).not.toContain("step")
    }
  })

  test("iteration_start leaves the display untouched", () => {
    const before = reduceRunDisplay(NO_RUN_DISPLAY, runStart())
    expect(reduceRunDisplay(before, iteration(7))).toEqual(before)
  })

  test("no row uses bare arrow notation", () => {
    expect(row2Text({ running: true, lastCallUsage: { inputTokens: 20_000 }, runUsage: { inputTokens: 70_000 } }))
      .not.toMatch(/[↑↓]/)
  })
})

// ---------------------------------------------------------------------------
// 7 — width-aware fitting (the deterministic drop order)
// ---------------------------------------------------------------------------

describe("narrow terminals drop run telemetry first", () => {
  const row = footerRows({
    ...baseInput,
    running: true,
    lastCallUsage: { inputTokens: 20_000, outputTokens: 900 },
    runRequests: 4,
    runUsage: { inputTokens: 70_000, outputTokens: 900 },
  }).row2
  const full = footerRowText(row)

  test("run requests go first", () => {
    const fitted = footerRowText(fitFooterRow(row, displayWidth(full) - 1))
    expect(fitted).not.toContain("run 4 req")
    expect(fitted).toContain("70k in / 900 out")
  })

  test("then the run tokens, then the rule, then usable, then the gauge", () => {
    const f1 = footerRowText(fitFooterRow(row, displayWidth(full) - 1))
    const f2 = footerRowText(fitFooterRow(row, displayWidth(f1) - 1))
    expect(f2).not.toContain("70k in / 900 out")
    expect(f2).toContain("auto-compact at 80%")

    const f3 = footerRowText(fitFooterRow(row, displayWidth(f2) - 1))
    expect(f3).not.toContain("auto-compact at 80%")
    expect(f3).toContain("usable")

    const f4 = footerRowText(fitFooterRow(row, displayWidth(f3) - 1))
    expect(f4).not.toContain("usable")
    expect(f4).toContain("[")

    const f5 = footerRowText(fitFooterRow(row, displayWidth(f4) - 1))
    expect(f5).not.toContain("[")
    expect(f5).toContain("Context 20k/96k")
  })

  test("the context number is never dropped", () => {
    expect(footerRowText(fitFooterRow(row, 12))).toContain("Context")
  })

  test("a fitted row fits once the viewport can hold its non-droppable fields", () => {
    for (const width of [20, 40, 80, 120]) {
      expect(displayWidth(footerRowText(fitFooterRow(row, width)))).toBeLessThanOrEqual(width)
    }
  })

  test("the rendered line never exceeds the viewport, however narrow", async () => {
    const { FooterLineView } = await import("./interactive/view/footer")
    const lines = footerRows({
      ...baseInput,
      running: true,
      lastCallUsage: { inputTokens: 20_000, outputTokens: 900 },
      runRequests: 4,
      runUsage: { inputTokens: 70_000, outputTokens: 900 },
    })
    for (const width of [4, 10, 20, 40, 80, 120]) {
      const row1 = new FooterLineView()
      row1.setRow(lines.row1)
      const row2 = new FooterLineView()
      row2.setRow(lines.row2)
      for (const line of [...row1.render(width), ...row2.render(width)]) {
        expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(width)
      }
    }
  })

  test("row 1 truncates the path (keeping its tail) before dropping the model", () => {
    const long = footerRows({ ...baseInput, cwd: "/home/dev/very/long/workspace/path/project" }).row1
    const fitted = footerRowText(fitFooterRow(long, 48))
    expect(fitted).toContain("…")
    expect(fitted).toContain("(main)")
    expect(fitted).toContain("Idle")
    // The model identity survives an ordinary narrow terminal.
    expect(fitted).toContain("128k window")
    expect(displayWidth(fitted)).toBeLessThanOrEqual(48)
  })

  test("row 1 keeps state and branch even at a tiny width", () => {
    const long = footerRows({ ...baseInput, cwd: "/home/dev/very/long/workspace/path/project" }).row1
    const fitted = footerRowText(fitFooterRow(long, 16))
    expect(fitted).toContain("Idle")
    expect(fitted).toContain("(main)")
    expect(displayWidth(fitted)).toBeLessThanOrEqual(16)
  })
})

// ---------------------------------------------------------------------------
// 8 — token formatting
// ---------------------------------------------------------------------------

describe("token formatting", () => {
  test("abridges at the footer's scale", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(900)).toBe("900")
    expect(formatTokens(1_200)).toBe("1.2k")
    expect(formatTokens(20_000)).toBe("20k")
    expect(formatTokens(96_000)).toBe("96k")
    expect(formatTokens(1_000_000)).toBe("1M")
  })
})

// ---------------------------------------------------------------------------
// 9 — run summary (transcript)
// ---------------------------------------------------------------------------

describe("the run summary renders the record as given", () => {
  const record: RunSummary = {
    id: "r1", startedAt: 1, finishedAt: 2, model: MODEL,
    usage: { inputTokens: 2300, outputTokens: 95 },
    modelCalls: 3, toolCalls: 2, finishReason: "stop",
  }

  test("counts and tokens are the record's own values", () => {
    const lines = runSummaryLines(record)
    expect(lines).toContain("3 model calls · 2 tool calls")
    expect(lines).toContain("↑2300 input · ↓95 output")
  })

  test("a token count the provider omitted is left out, not zeroed", () => {
    const lines = runSummaryLines({ ...record, usage: { outputTokens: 95 } })
    expect(lines.join(" ")).toContain("↓95 output")
    expect(lines.join(" ")).not.toContain("input")
  })

  test("an unfinished record renders only what it actually holds", () => {
    expect(runSummaryLines({ id: "r1", startedAt: 1, model: MODEL })).toEqual([])
  })

  test("a partially reported record shows the parts it has", () => {
    expect(runSummaryLines({ id: "r1", startedAt: 1, model: MODEL, modelCalls: 1 })).toEqual(["1 model call"])
  })
})

// ---------------------------------------------------------------------------
// 10 — tool duration
// ---------------------------------------------------------------------------

describe("tool duration comes from the runtime", () => {
  test("a reported duration renders on the tool line", async () => {
    const { ToolExecutionComponent } = await import("./interactive/view/components")
    const withDuration = new ToolExecutionComponent("c1", "bash", { command: "true" })
    withDuration.setResult(true, "ok", 1250)
    expect(withDuration.render(200).join("\n")).toContain("1.3s")

    const without = new ToolExecutionComponent("c2", "bash", { command: "true" })
    without.setResult(true, "ok")
    // An unreported duration stays absent rather than reading as instant.
    expect(without.render(200).join("\n")).not.toContain("·")
  })

  test("sub-second durations read in milliseconds", async () => {
    const { ToolExecutionComponent } = await import("./interactive/view/components")
    const tool = new ToolExecutionComponent("c1", "ls", { path: "." })
    tool.setResult(true, "ok", 4)
    expect(tool.render(200).join("\n")).toContain("4ms")
  })
})

// ---------------------------------------------------------------------------
// 11 — compaction usage
// ---------------------------------------------------------------------------

describe("a compaction reports its own cost", () => {
  test("the cost is shown when the runtime reported one", () => {
    expect(compactionNoticeText(3, { inputTokens: 400, outputTokens: 50 }))
      .toBe("context compacted — 3 messages summarized · ↑400 ↓50")
  })

  test("no cost is invented when none was reported", () => {
    expect(compactionNoticeText(3, undefined)).toBe("context compacted — 3 messages summarized")
  })
})

// ---------------------------------------------------------------------------
// 12 — pruning
// ---------------------------------------------------------------------------

describe("pruning appears only when something was withheld", () => {
  const record: RunSummary = { id: "r1", startedAt: 1, model: MODEL }

  test("a run that pruned says so", () => {
    const text = runSummaryLines({ ...record, pruning: { reduced: 2, originalBytes: 2048 } }).join(" ")
    expect(text).toContain("pruned 2 tool results")
    expect(text).toContain("2.0KB")
  })

  test("a run that pruned nothing says nothing", () => {
    const lines = runSummaryLines({ ...record, pruning: { reduced: 0, originalBytes: 0 } })
    expect(lines.join(" ")).not.toContain("pruned")
  })

  test("a run with no pruning record says nothing", () => {
    expect(runSummaryLines(record).join(" ")).not.toContain("pruned")
  })

  test("one withheld result reads in the singular", () => {
    expect(runSummaryLines({ ...record, pruning: { reduced: 1, originalBytes: 40 } }).join(" "))
      .toContain("pruned 1 tool result (40B)")
  })
})

// ---------------------------------------------------------------------------
// 13 — JSON result line
// ---------------------------------------------------------------------------

describe("the final JSON line carries the run record", () => {
  const record: RunSummary = {
    id: "r1", startedAt: 1, finishedAt: 2, model: MODEL,
    usage: { inputTokens: 2300 }, modelCalls: 3, toolCalls: 2, finishReason: "stop",
  }

  test("it keeps its existing fields and adds identity and the record", () => {
    expect(resultLine("stop", 4, undefined, record)).toEqual({
      type: "result",
      finishReason: "stop",
      iterations: 4,
      error: null,
      runId: "r1",
      run: record,
    })
  })

  test("it still reads sensibly when no record was captured", () => {
    expect(resultLine("error", 1, "boom", undefined)).toEqual({
      type: "result",
      finishReason: "error",
      iterations: 1,
      error: "boom",
    })
  })
})

// ---------------------------------------------------------------------------
// 14 — finish reason
// ---------------------------------------------------------------------------

describe("terminal states stay distinguishable without claiming success", () => {
  const state = (finishReason: RunFinishReason, finishedAt?: number): RunSummary => ({
    id: "r1", startedAt: 1, model: MODEL, finishReason,
    ...(finishedAt === undefined ? {} : { finishedAt }),
  })

  test("a normal stop reads as a finished run, never as a solved task", () => {
    const line = runStateLine(state("stop", 12_400))
    expect(line).toBe("● finished · 12.4s")
    // Neither the words nor a tick: both would claim the task, not the run.
    expect(line).not.toMatch(/success|succeed|solved|completed|done|✓|✔/i)
  })

  test("a user interrupt is distinguishable from a completion", () => {
    expect(runStateLine(state("aborted", 2_000))).toBe("■ interrupted · 2.0s")
  })

  test("an errored run is distinguishable from both", () => {
    expect(runStateLine(state("error", 501))).toBe("▲ ended in error · 500ms")
  })

  test("every reason without a final answer is named", () => {
    for (const reason of ["max-iterations", "doom-loop", "length", "unknown"] as const) {
      expect(runStateLine(state(reason))).toBe(`▲ ended without a final answer (${reason})`)
    }
  })

  test("a run whose end was not recorded reports no duration", () => {
    // startedAt without finishedAt: nothing to subtract, so nothing is shown.
    expect(runStateLine(state("stop"))).toBe("● finished")
  })

  test("a run that has not ended states nothing at all", () => {
    expect(runStateLine({ id: "r1", startedAt: 1, model: MODEL })).toBeUndefined()
    expect(runSummaryLines({ id: "r1", startedAt: 1, model: MODEL })).toEqual([])
  })

  test("the summary leads with the state and the elapsed time", () => {
    expect(runSummaryLines(state("stop", 12_400))[0]).toBe("● finished · 12.4s")
  })

  test("no terminal state renders a tick", () => {
    for (const reason of ["stop", "aborted", "error", "max-iterations", "doom-loop", "length", "unknown"] as const) {
      expect(runStateLine(state(reason, 2))).not.toMatch(/✓|✔/)
    }
  })

  test("a count of one reads in the singular", () => {
    const lines = runSummaryLines({ id: "r1", startedAt: 1, model: MODEL, modelCalls: 1, toolCalls: 1 })
    expect(lines).toEqual(["1 model call · 1 tool call"])
  })

  test("a finish time before the start reports no duration", () => {
    // Only a clock step can produce this; it is not a run fact.
    expect(runStateLine({ id: "r1", startedAt: 5_000, finishedAt: 1_000, model: MODEL, finishReason: "stop" }))
      .toBe("● finished")
  })
})
