import { describe, expect, test } from "bun:test"
import type { ModelLimits } from "@minicode/model"
import { contextBudget } from "@minicode/agent"
import type { ModelIdentity, RunEvent, RunFinishReason, RunSummary } from "@minicode/agent"
import {
  NO_RUN_DISPLAY,
  compactionNoticeText,
  contextReading,
  footerSegments,
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

const LIMITS: ModelLimits = { contextWindow: 1000, maxOutputTokens: 250 }

const runStart = (): RunEvent => ({ type: "run_start", sessionId: "s1", runId: "r1", task: "t", model: MODEL })
const step = (iteration: number): RunEvent => ({ type: "iteration_start", iteration })
const responded = (inputTokens?: number, outputTokens?: number): RunEvent => ({
  type: "model_response",
  iteration: 1,
  finishReason: "tool_call",
  ...(inputTokens === undefined && outputTokens === undefined
    ? {}
    : { usage: { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) } }),
})
const ended = (run: RunSummary): RunEvent => ({
  type: "run_end",
  runId: run.id,
  finishReason: run.finishReason ?? "stop",
  iterations: 1,
  run,
})

const baseFooter: FooterInput = {
  cwd: "/home/dev/project",
  branch: "main",
  lastCallUsage: undefined,
  runUsage: undefined,
  limits: LIMITS,
  compactThresholdPct: 80,
  running: true,
  step: 1,
}

const footerText = (overrides: Partial<FooterInput> = {}): string =>
  footerSegments({ ...baseFooter, ...overrides }).map(segment => segment.text).join("  ·  ")

// ---------------------------------------------------------------------------
// 1 — last call vs run usage
// ---------------------------------------------------------------------------

describe("the last call and the whole run never share a field", () => {
  test("the last call's usage is the latest call, and run usage is not it", () => {
    let display = reduceRunDisplay(NO_RUN_DISPLAY, runStart())
    display = reduceRunDisplay(display, step(1))
    display = reduceRunDisplay(display, responded(100, 20))
    display = reduceRunDisplay(display, responded(300, 40))

    // The latest call, not a running sum.
    expect(display.lastCallUsage).toEqual({ inputTokens: 300, outputTokens: 40 })
    expect(display.runUsage).toBeUndefined()
  })

  test("run totals arrive without disturbing the last-call reading", () => {
    let display = reduceRunDisplay(NO_RUN_DISPLAY, runStart())
    display = reduceRunDisplay(display, responded(300, 40))
    display = reduceRunDisplay(display, ended({
      id: "r1", startedAt: 1, model: MODEL,
      usage: { inputTokens: 900, outputTokens: 120 }, finishReason: "stop",
    }))

    expect(display.runUsage).toEqual({ inputTokens: 900, outputTokens: 120 })
    // The run total must never become the last call…
    expect(display.lastCallUsage).toEqual({ inputTokens: 300, outputTokens: 40 })
  })

  test("a new run carries nothing over from the previous one", () => {
    let display = reduceRunDisplay(NO_RUN_DISPLAY, runStart())
    display = reduceRunDisplay(display, responded(300, 40))
    display = reduceRunDisplay(display, ended({ id: "r1", startedAt: 1, model: MODEL, usage: { inputTokens: 900 } }))

    expect(reduceRunDisplay(display, runStart())).toEqual(NO_RUN_DISPLAY)
  })

  test("the two figures are separate, labelled segments", () => {
    const text = footerText({
      lastCallUsage: { inputTokens: 300, outputTokens: 40 },
      runUsage: { inputTokens: 900, outputTokens: 120 },
    })
    expect(text).toContain("↑300 ↓40")
    expect(text).toContain("run ↑900 ↓120")
  })

  test("a call the provider reported nothing for leaves the reading untouched", () => {
    const display = reduceRunDisplay({ ...NO_RUN_DISPLAY, lastCallUsage: { inputTokens: 5 } }, responded())
    expect(display.lastCallUsage).toEqual({ inputTokens: 5 })
  })
})

// ---------------------------------------------------------------------------
// 2 — context budget
// ---------------------------------------------------------------------------

describe("context pressure is measured against the runtime's input budget", () => {
  test("the reading reaches 100% at the input budget, not at the window", () => {
    const { inputBudget } = contextBudget(LIMITS)

    expect(contextReading(inputBudget, LIMITS, 80)?.percent).toBe(100)
    expect(contextReading(inputBudget / 2, LIMITS, 80)?.percent).toBe(50)
    // Half the window is not the same reading, which is the defect being fixed.
    expect(contextReading(LIMITS.contextWindow / 2, LIMITS, 80)?.percent).not.toBe(50)
  })

  test("the displayed threshold is the configured one, never a recomputation", () => {
    for (const pct of [50, 80, 95]) {
      expect(contextReading(100, LIMITS, pct)?.compactAtPercent).toBe(pct)
    }
  })

  test("no reading is invented when an input is missing", () => {
    expect(contextReading(undefined, LIMITS, 80)).toBeUndefined()
    expect(contextReading(100, undefined, 80)).toBeUndefined()
    expect(contextReading(100, LIMITS, undefined)).toBeUndefined()
  })

  test("the footer shows the reading with its threshold", () => {
    const { inputBudget } = contextBudget(LIMITS)
    expect(footerText({ lastCallUsage: { inputTokens: inputBudget } })).toContain("ctx 100% · compact 80%")
  })
})

// ---------------------------------------------------------------------------
// 3 — model switch
// ---------------------------------------------------------------------------

describe("the reading follows the model in use", () => {
  test("the same call reads against whichever budget it is given", () => {
    const small: ModelLimits = { contextWindow: 1000, maxOutputTokens: 250 }
    const large: ModelLimits = { contextWindow: 8000, maxOutputTokens: 1000 }

    expect(contextReading(750, small, 80)?.percent).toBe(100)
    // The same 750 tokens against the larger model's own budget.
    expect(contextReading(750, large, 80)?.percent)
      .toBe(Math.round((750 / contextBudget(large).inputBudget) * 100))
    expect(contextReading(750, large, 80)?.percent).toBeLessThan(100)
  })
})

// ---------------------------------------------------------------------------
// 4 — step semantics
// ---------------------------------------------------------------------------

describe("the step counter is never presented as a call count", () => {
  test("it is labelled a step, and no segment claims model calls", () => {
    const text = footerText({ step: 3 })
    expect(text).toContain("step 3")
    expect(text).not.toMatch(/model calls?/i)
  })

  test("it tracks the runtime's counter as sent", () => {
    const display = reduceRunDisplay(reduceRunDisplay(NO_RUN_DISPLAY, runStart()), step(4))
    expect(display.step).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// 5 — final run summary
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

  test("the run's totals are labelled apart from the last call's", () => {
    const lines = runSummaryLines(record).join(" ")
    // The footer's bare `↑in ↓out` is the last call; these are the run's.
    expect(lines).toContain("input")
    expect(lines).toContain("output")
  })

  test("a token count the provider omitted is left out, not zeroed", () => {
    const lines = runSummaryLines({ ...record, usage: { outputTokens: 95 } })
    expect(lines.join(" ")).toContain("↓95 output")
    expect(lines.join(" ")).not.toContain("input")
  })

  test("an unfinished record renders only what it actually holds", () => {
    // Nothing terminal is known, so nothing terminal is shown.
    expect(runSummaryLines({ id: "r1", startedAt: 1, model: MODEL })).toEqual([])
  })

  test("a partially reported record shows the parts it has", () => {
    const lines = runSummaryLines({ id: "r1", startedAt: 1, model: MODEL, modelCalls: 1 })
    expect(lines).toEqual(["1 model call"])
  })
})

// ---------------------------------------------------------------------------
// 6 — tool duration
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
// 7 — compaction usage
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
// 8 — pruning
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
// 9 — JSON result line
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
// 10 — finish reason
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

// ---------------------------------------------------------------------------
// O1 compatibility — subset fields
// ---------------------------------------------------------------------------

describe("subset token fields are never folded into the totals", () => {
  test("the pair shown is the totals, exactly as reported", () => {
    const text = footerText({
      lastCallUsage: {
        inputTokens: 1050,
        outputTokens: 20,
        totalTokens: 1070,
        cacheReadTokens: 900,
        reasoningTokens: 7,
      },
    })
    expect(text).toContain("↑1050 ↓20")
    // The cached and reasoning portions are decompositions, not additions.
    expect(text).not.toContain("1950")
    expect(text).not.toContain("27")
  })

  test("a missing count is omitted, never rendered as zero", () => {
    const text = footerText({ lastCallUsage: { inputTokens: 100 } })
    expect(text).toContain("↑100")
    expect(text).not.toContain("↓")

    const runText = footerText({ runUsage: { outputTokens: 8 } })
    expect(runText).toContain("run ↓8")
    expect(runText).not.toContain("↑")
  })
})
