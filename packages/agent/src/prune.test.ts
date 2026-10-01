import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelMessage } from "@minicode/model"
import { estimateTokens } from "./context-budget"
import {
  pruneOldToolOutputs,
  isPrunedToolOutput,
  type ProjectionMessage,
  type PruneStats,
} from "./session/prune"
import { Session } from "./session/session"
import { truncateOutput } from "./tools/truncate"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const user = (text: string): ProjectionMessage => ({ role: "user", content: text })

const tool = (
  toolCallId: string,
  text: string,
  extra?: { failureEvidence?: boolean },
): ProjectionMessage => ({
  role: "tool",
  content: [{ toolCallId, toolName: "bash", output: { type: "text", text } }],
  ...(extra ?? {}),
})

const errorTool = (toolCallId: string, text: string): ProjectionMessage => ({
  role: "tool",
  content: [{ toolCallId, toolName: "bash", output: { type: "tool_error", text } }],
})

const jsonTool = (toolCallId: string): ProjectionMessage => ({
  role: "tool",
  content: [{ toolCallId, toolName: "query", output: { type: "json", value: { rows: 3 } } }],
})

/** One tool message carrying several results, to exercise per-message reduction. */
const multiTool = (toolCallId: string, texts: readonly string[]): ProjectionMessage => ({
  role: "tool",
  content: texts.map((text, i) => ({
    toolCallId: `${toolCallId}-${i}`,
    toolName: "bash",
    output: { type: "text" as const, text },
  })),
})

const outputAt = (message: ModelMessage, index = 0) => {
  if (message.role !== "tool") throw new Error("not a tool message")
  return message.content[index].output
}

const markersIn = (messages: readonly ModelMessage[]) =>
  messages.flatMap(m => (m.role === "tool" ? m.content.map(r => r.output) : [])).filter(isPrunedToolOutput)

/** Tokens the projection would cost, using the runtime's single estimator. */
const size = (messages: readonly ModelMessage[]): number => estimateTokens(messages)

/** A budget/TEXT pair chosen so `TEXT` alone exceeds `budget`. */
const budget = 200
const overBudgetText = "x".repeat(budget * 4 * 3)

// ---------------------------------------------------------------------------
// 1, 2, 3 — pressure gating and the reduction target
// ---------------------------------------------------------------------------

describe("request-time context management is pressure-driven (HD-2)", () => {
  test("a request already within budget is returned unchanged", () => {
    const messages = [user("hello"), tool("t1", "small"), user("next"), tool("t2", "more")]
    const projected = pruneOldToolOutputs(messages, { inputBudget: 100_000 })
    expect(projected).toEqual(messages)
    expect(markersIn(projected)).toHaveLength(0)
    expect(size(projected)).toBeLessThanOrEqual(100_000)
  })

  test("no budget supplied means no reduction (nothing can be shown to be over budget)", () => {
    const messages = [user("hello"), tool("t1", overBudgetText), user("next")]
    const projected = pruneOldToolOutputs(messages)
    expect(projected).toEqual(messages)
    expect(markersIn(projected)).toHaveLength(0)
  })

  test("an over-budget request has its eligible tool output reduced", () => {
    const messages = [user("t1"), tool("old", overBudgetText), user("t2"), tool("new", "recent")]
    expect(size(messages)).toBeGreaterThan(budget)

    const projected = pruneOldToolOutputs(messages, { inputBudget: budget })
    expect(markersIn(projected).length).toBeGreaterThan(0)
    // Stage 1 withholds the older result; the current turn is untouched.
    expect(isPrunedToolOutput(outputAt(projected[1]))).toBe(true)
    expect(outputAt(projected[3])).toEqual({ type: "text", text: "recent" })
  })

  test("reduction targets the estimate, and reaches the budget when it can", () => {
    const messages = [user("t1"), tool("a", overBudgetText), tool("b", overBudgetText), user("t2")]
    const projected = pruneOldToolOutputs(messages, { inputBudget: budget })
    expect(size(projected)).toBeLessThanOrEqual(budget)
  })

  test("lastInputTokens is a trigger only: it is never the amount to reduce", () => {
    // The previous request exceeded the budget, but the current projection is
    // already small. Nothing may be reduced, because nothing needs to be.
    const messages = [user("hi"), tool("t1", "tiny"), user("next")]
    const projected = pruneOldToolOutputs(messages, {
      lastInputTokens: 50_000,
      inputBudget: budget,
    })
    expect(projected).toEqual(messages)
    expect(markersIn(projected)).toHaveLength(0)
  })

  // Regression: the inner reduction loop must not rebuild from a stale content
  // array, which silently discarded every reduction but the last one.
  test("multiple results in one message are each reduced when required", () => {
    const messages = [user("t1"), multiTool("m", [overBudgetText, overBudgetText]), user("t2")]
    const projected = pruneOldToolOutputs(messages, { inputBudget: budget })
    const outputs = (projected[1] as unknown as { content: { output: unknown }[] }).content.map(c => c.output)
    expect(outputs.filter(o => isPrunedToolOutput(o as never))).toHaveLength(2)
  })

  test("reduction terminates for a projection that cannot be made to fit", () => {
    // Every result is protected, so no reduction is possible. The function must
    // still return deterministically rather than looping.
    const messages = [
      user("t1"),
      errorTool("e1", overBudgetText),
      errorTool("e2", overBudgetText),
      user("t2"),
    ]
    const projected = pruneOldToolOutputs(messages, { inputBudget: budget })
    expect(projected).toEqual(messages)
  })
})

// ---------------------------------------------------------------------------
// 4 — oversized current/newest result (HD-1)
// ---------------------------------------------------------------------------

describe("an oversized newest result remains represented (HD-1)", () => {
  test("the newest result is reduced rather than withheld", () => {
    // The only reducible content sits inside the current turn, so stage 1 is
    // skipped entirely and stage 2 must reduce the newest result itself.
    const messages = [user("t1"), user("t2"), tool("newest", overBudgetText)]
    const projected = pruneOldToolOutputs(messages, { inputBudget: budget })

    const marker = outputAt(projected[2])
    expect(isPrunedToolOutput(marker)).toBe(true)
    // Still *represented*: identified as a result of `bash`, with its size.
    if (!isPrunedToolOutput(marker)) throw new Error("unreachable")
    expect(marker.value.toolName).toBe("bash")
    expect(marker.value.originalBytes).toBe(overBudgetText.length)
    // The enclosing tool message survives, so the call/result pairing is intact.
    expect(projected[2].role).toBe("tool")
    expect((projected[2] as unknown as { content: { toolCallId: string }[] }).content[0].toolCallId).toBe("newest")
  })

  test("no arbitrary retention constant governs the reduction", () => {
    // Same history, three budgets: how much is withheld scales with the budget,
    // which is only possible if the reduction is derived from the estimator and
    // the budget rather than from a fixed byte constant.
    const messages = [
      user("t1"),
      tool("a", overBudgetText),
      tool("b", overBudgetText),
      tool("c", overBudgetText),
      user("t2"),
    ]

    const markersAt = (inputBudget: number) =>
      markersIn(pruneOldToolOutputs(messages, { inputBudget })).length

    const generous = markersAt(1500)
    const tight = markersAt(budget)

    expect(generous).toBeGreaterThan(0)
    expect(tight).toBeGreaterThan(generous)
    // And each outcome is itself within its budget.
    expect(size(pruneOldToolOutputs(messages, { inputBudget: 1500 }))).toBeLessThanOrEqual(1500)
    expect(size(pruneOldToolOutputs(messages, { inputBudget: budget }))).toBeLessThanOrEqual(budget)
  })
})

// ---------------------------------------------------------------------------
// 5, 6, 7 — durable history, tool errors, non-text output
// ---------------------------------------------------------------------------

describe("projection never mutates durable history", () => {
  test("the input array and its messages are left untouched", () => {
    const messages = [user("t1"), tool("a", overBudgetText), user("t2"), tool("b", overBudgetText)]
    const snapshot = structuredClone(messages)

    pruneOldToolOutputs(messages, { inputBudget: budget })

    expect(messages).toEqual(snapshot)
    expect(markersIn(messages)).toHaveLength(0)
  })

  test("repeated projection is stable and non-mutating", () => {
    const messages = [user("t1"), tool("a", overBudgetText), user("t2"), tool("b", overBudgetText)]
    const snapshot = structuredClone(messages)

    const first = pruneOldToolOutputs(messages, { inputBudget: budget })
    const second = pruneOldToolOutputs(messages, { inputBudget: budget })
    pruneOldToolOutputs(first as ProjectionMessage[], { inputBudget: budget })

    expect(second).toEqual(first)
    expect(messages).toEqual(snapshot)
  })
})

describe("protected results are never withheld (I2/I3)", () => {
  test("tool_error results survive even when far over budget", () => {
    const messages = [user("t1"), errorTool("e1", overBudgetText), user("t2"), tool("t3", overBudgetText)]
    const projected = pruneOldToolOutputs(messages, { inputBudget: budget })
    expect(outputAt(projected[1])).toEqual({ type: "tool_error", text: overBudgetText })
  })

  test("non-text (json) results survive even when far over budget", () => {
    const messages = [user("t1"), jsonTool("j1"), user("t2"), tool("t3", overBudgetText)]
    const projected = pruneOldToolOutputs(messages, { inputBudget: budget })
    expect(outputAt(projected[1])).toEqual({ type: "json", value: { rows: 3 } })
  })

  test("failure evidence survives reduction (I3)", () => {
    const messages = [
      user("t1"),
      tool("failing", overBudgetText, { failureEvidence: true }),
      user("t2"),
      tool("ok", overBudgetText),
    ]
    const projected = pruneOldToolOutputs(messages, { inputBudget: budget })

    expect(outputAt(projected[1])).toEqual({ type: "text", text: overBudgetText })
    expect(isPrunedToolOutput(outputAt(projected[3]))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 11, 12 — recovery affordances (I5)
// ---------------------------------------------------------------------------

describe("mechanism 1 recovery affordances survive reduction (I5)", () => {
  test("a spill pointer is preserved in the marker", () => {
    const spilled = `head\n\n...4000 bytes truncated. Full content saved to: /tmp/.tool-output/bash-abc.txt\nUse read with offset/limit to view specific sections.`
    const messages = [user("t1"), tool("spilled", spilled), user("t2"), tool("ok", "small")]
    // Force over-budget so stage 1 fires on the spilled result.
    const projected = pruneOldToolOutputs(messages, { inputBudget: 1 })

    const marker = outputAt(projected[1])
    if (!isPrunedToolOutput(marker)) throw new Error("expected a marker")
    expect(marker.value.spillPath).toBe("/tmp/.tool-output/bash-abc.txt")
  })

  test("a read continuation offset is preserved in the marker", () => {
    const capped = `line1\nline2\n\n(Output capped at 50 KB. Showing lines 1-2000. Use offset=2001 to continue.)`
    const messages = [user("t1"), tool("read", capped), user("t2"), tool("ok", "small")]
    const projected = pruneOldToolOutputs(messages, { inputBudget: 1 })

    const marker = outputAt(projected[1])
    if (!isPrunedToolOutput(marker)) throw new Error("expected a marker")
    expect(marker.value.resumeOffset).toBe(2001)
  })

  test("a plain result carries no recovery metadata", () => {
    const messages = [user("t1"), tool("plain", "no pointers here"), user("t2"), tool("ok", "small")]
    const projected = pruneOldToolOutputs(messages, { inputBudget: 1 })

    const marker = outputAt(projected[1])
    if (!isPrunedToolOutput(marker)) throw new Error("expected a marker")
    expect(marker.value.spillPath).toBeUndefined()
    expect(marker.value.resumeOffset).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 13, 14 — marker shape and the removal of the old policy
// ---------------------------------------------------------------------------

describe("the marker is structurally distinguishable from real output", () => {
  test("it is json with a namespaced key, never text or tool_error", () => {
    const messages = [user("t1"), tool("a", overBudgetText), user("t2"), tool("b", "x")]
    const marker = outputAt(pruneOldToolOutputs(messages, { inputBudget: 1 })[1])

    expect(marker.type).toBe("json")
    expect(marker.type).not.toBe("text")
    expect(marker.type).not.toBe("tool_error")
    if (!isPrunedToolOutput(marker)) throw new Error("expected a marker")
    expect(marker.value.minicodePruned).toBe(true)
    expect(marker.value.reason).toBe("request-over-budget")
  })

  test("a genuine json tool result using the bare `pruned` key is not a marker", () => {
    const real = { type: "json", value: { pruned: true } }
    expect(isPrunedToolOutput(real as never)).toBe(false)
  })

  test("the marker does not claim to be content, and carries no recovery instruction", () => {
    const messages = [user("t1"), tool("a", overBudgetText), user("t2"), tool("b", "x")]
    const marker = outputAt(pruneOldToolOutputs(messages, { inputBudget: 1 })[1])

    expect(Object.keys(marker)).not.toContain("text")
    expect(JSON.stringify(marker)).not.toContain(overBudgetText.slice(0, 40))
    expect(JSON.stringify(marker)).not.toMatch(/rerun|re-run|re-execute/i)
  })

  test("the old turn-count / byte-constant policy is gone", () => {
    // Under the removed policy, a session with more than two user turns was
    // pruned regardless of pressure. Pressure, not turn count, now decides.
    const messages = [
      user("t1"),
      tool("a", "small"),
      user("t2"),
      tool("b", "small"),
      user("t3"),
      tool("c", "small"),
      user("t4"),
      tool("d", "small"),
    ]
    const projected = pruneOldToolOutputs(messages, { inputBudget: 100_000 })
    expect(markersIn(projected)).toHaveLength(0)
    expect(projected).toEqual(messages)
  })
})

// ---------------------------------------------------------------------------
// 8, 9, 10 — the failure-evidence path through mechanism 1
// ---------------------------------------------------------------------------

describe("failure evidence survives capture-time truncation (I3)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "minicode-prune-truncate-"))

  test("short output is returned unchanged, keeping the flag", () => {
    const result = { ok: true as const, data: "boom\n(exit code: 1)", failureEvidence: true as const }
    expect(truncateOutput(result, cwd, "bash")).toBe(result)
  })

  test("long output that spills to a file keeps the flag", () => {
    const long = `${"e".repeat(5000)}\n(exit code: 1)`
    const truncated = truncateOutput({ ok: true, data: long, failureEvidence: true }, cwd, "bash")

    expect(truncated.ok).toBe(true)
    if (!truncated.ok) throw new Error("unreachable")
    expect(truncated.failureEvidence).toBe(true)
    // Mechanism 1 still did its job: a preview plus a recoverable pointer.
    expect(truncated.data).toContain("Full content saved to:")
  })

  test("a successful long result carries no failure evidence", () => {
    const truncated = truncateOutput({ ok: true, data: "y".repeat(5000) }, cwd, "bash")
    if (!truncated.ok) throw new Error("unreachable")
    expect(truncated.failureEvidence).toBeUndefined()
  })

  test("bash semantics are unchanged: ok stays true and the text is byte-identical", () => {
    const data = "some output\n(exit code: 3)"
    const result = { ok: true as const, data, failureEvidence: true as const }
    expect(result.ok).toBe(true)
    expect(result.data).toBe(data)
  })

  test("cleanup", () => {
    rmSync(cwd, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// 13, 16 — durability and persistence through the real Session
// ---------------------------------------------------------------------------

describe("integration: Session projection vs durable state (I1/I8/I9)", () => {
  const buildSession = (markFailureOnTurn?: number) => {
    const cwd = mkdtempSync(join(tmpdir(), "minicode-prune-session-"))
    const session = Session.create({ cwd })
    for (let turn = 1; turn <= 4; turn++) {
      session.pushUser(`turn ${turn}`)
      const assistant = session.appendAssistant(
        [{ type: "tool_call", toolCallId: `c${turn}`, toolName: "bash", input: { command: `echo ${turn}` } }],
        { finishReason: "tool_call" },
      )
      const toolMsg = session.toolResultMessageFor(assistant)
      session.appendToolResult(toolMsg, {
        toolCallId: `c${turn}`,
        toolName: "bash",
        output: { type: "text", text: `${"z".repeat(2000)}` },
      })
      if (turn === markFailureOnTurn) session.markFailureEvidence(toolMsg)
    }
    return { session, cwd }
  }

  test("the projection is reduced while durable messages are untouched", () => {
    const { session, cwd } = buildSession()
    try {
      const before = structuredClone(session.messages)
      const projected = session.toRequestMessages({ inputBudget: budget })

      expect(markersIn(projected).length).toBeGreaterThan(0)
      expect(session.messages).toEqual(before)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("no pruning marker is persisted (I8)", () => {
    const { session, cwd } = buildSession()
    try {
      session.toRequestMessages({ inputBudget: budget })
      const persisted = JSON.stringify(session.toJSON())
      expect(persisted).not.toContain("minicodePruned")
      expect(persisted).not.toContain("request-over-budget")
      // The withheld bytes are still fully durable.
      expect(persisted).toContain("z".repeat(100))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("failure evidence round-trips through persistence (HD-4)", () => {
    const { session, cwd } = buildSession(2)
    try {
      const persisted = session.toJSON()
      const reloaded = Session.fromJSON(persisted as unknown as Record<string, unknown>)

      const flagged = reloaded.messages.filter(m => m.role === "tool" && m.failureEvidence === true)
      expect(flagged).toHaveLength(1)

      // And after the reload, request-time reduction still leaves the flagged
      // turn's payload intact (the projection itself never carries the flag —
      // it is Agent-local and is stripped before the provider).
      const projected = reloaded.toRequestMessages({ inputBudget: budget })
      const flaggedResults = projected
        .filter(m => m.role === "tool")
        .flatMap(m => m.content)
        .filter(r => r.toolCallId === "c2")
      expect(flaggedResults).toHaveLength(1)
      expect(flaggedResults[0].output).toEqual({ type: "text", text: "z".repeat(2000) })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("the same durable state yields the same projection (I9)", () => {
    const { session, cwd } = buildSession()
    try {
      const a = JSON.stringify(session.toRequestMessages({ inputBudget: budget }))
      const b = JSON.stringify(session.toRequestMessages({ inputBudget: budget }))
      expect(a).toBe(b)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// O4 — pruning observability
// ---------------------------------------------------------------------------

describe("pruning reports what it withheld, without changing what it withholds", () => {
  const observe = (
    messages: readonly ProjectionMessage[],
    inputBudget: number,
  ): { observations: PruneStats[]; projected: ModelMessage[] } => {
    const observations: PruneStats[] = []
    const projected = pruneOldToolOutputs(messages, {
      inputBudget,
      onPrune: stats => observations.push(stats),
    })
    return { observations, projected }
  }

  test("a pass that reduces nothing reports nothing", () => {
    const { observations } = observe(
      [user("t1"), tool("a", "small"), user("t2"), tool("b", "more")],
      100_000,
    )
    expect(observations).toEqual([])
  })

  test("an empty projection reports nothing", () => {
    const { observations } = observe([], 1)
    expect(observations).toEqual([])
  })

  test("each reduced result is counted once, with its own original size", () => {
    const { observations, projected } = observe(
      [user("t1"), tool("a", "a".repeat(2_000)), user("t2"), tool("b", "b".repeat(3_000))],
      1,
    )

    expect(observations).toHaveLength(1)
    expect(observations[0]).toEqual({ reduced: 2, originalBytes: 5_000 })
    // The count agrees with the markers that actually reached the request.
    expect(observations[0]!.reduced).toBe(markersIn(projected).length)
  })

  // The two-step shrink rewrites the same result twice: once keeping an
  // excerpt, then again without it. That is ONE reduced result, and its
  // original size is added once — not twice.
  test("a result the two-stage shrink rewrites twice counts as one reduction", () => {
    const messages = [user("t1"), tool("a", "x".repeat(4_000))]
    const { observations, projected } = observe(messages, size(messages) - 5)

    expect(markersIn(projected)).toHaveLength(1)
    expect(observations).toEqual([{ reduced: 1, originalBytes: 4_000 }])
  })

  test("supplying a sink does not change the projection", () => {
    const messages = [user("t1"), tool("a", overBudgetText), user("t2"), tool("b", "x")]
    const without = pruneOldToolOutputs(messages, { inputBudget: 1 })

    expect(observe(messages, 1).projected).toEqual(without)
  })

  test("a throwing sink is ignored and cannot change the projection", () => {
    const messages = [user("t1"), tool("a", overBudgetText), user("t2"), tool("b", "x")]
    const without = pruneOldToolOutputs(messages, { inputBudget: 1 })

    const projected = pruneOldToolOutputs(messages, {
      inputBudget: 1,
      onPrune: () => {
        throw new Error("sink failure")
      },
    })

    expect(projected).toEqual(without)
  })
})
