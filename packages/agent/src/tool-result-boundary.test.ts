/**
 * Tool-result boundary (P0-1 + P0-2).
 *
 * P0-1 — the canonical output boundary is unconditional: `ok` decides where
 * the bounded text lives (`data` vs `error`), never whether it is bounded.
 *
 * P0-2 — a recovery/spill affordance belongs to exactly one tool invocation and
 * is keyed by `toolCallId`; a turn with several results keeps them separate.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelAssistantPart, ModelToolResult } from "@minicode/model"
import { executeTool } from "./loop/execute"
import { isPrunedToolOutput } from "./session/prune"
import { Session } from "./session/session"
import { truncateOutput } from "./tools/truncate"
import type { Tool, ToolResult } from "./tools/types"

const THRESHOLD = 2048 // the canonical cap; this work deliberately does not change it.

function tempCwd(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "minicode-tool-boundary-"))
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}

function sess(cwd: string): Session {
  const session = Session.create({ cwd })
  session.onCheckpoint(async () => {})
  return session
}

const fixedTool = (result: ToolResult): Tool => ({
  description: "returns a fixed result",
  inputSchema: { type: "object" },
  execute: () => result,
})

const dataTool = (data: string): Tool => fixedTool({ ok: true, data })

/** The tool message of a session, asserted present. */
function toolMessage(session: Session) {
  const msg = session.messages.find(m => m.role === "tool")
  if (msg?.role !== "tool") throw new Error("expected a tool message")
  return msg
}

/** The projected tool message's results, after request-time reduction. */
function projectedResults(session: Session, budget = 1): ModelToolResult[] {
  const messages = session.toRequestMessages({ inputBudget: budget })
  const msg = messages.find(m => m.role === "tool")
  if (msg?.role !== "tool") throw new Error("expected a projected tool message")
  return [...msg.content]
}

const markerOf = (result: ModelToolResult) =>
  isPrunedToolOutput(result.output) ? result.output.value : undefined

// ---------------------------------------------------------------------------
// P0-1 — unconditional bounding
// ---------------------------------------------------------------------------

describe("P0-1 — failed results pass the canonical output boundary", () => {
  test("an oversized failure is bounded, stays failed, and keeps its diagnostic head", async () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const partial = Array.from({ length: 4000 }, (_, i) => `line-${i}`).join("\n")
      const error = `Command timed out after 2.0m.\nPartial output:\n${partial}`

      const capped = truncateOutput({ ok: false, error }, cwd, "bash")

      expect(capped.ok).toBe(false)
      if (capped.ok) throw new Error("unreachable")
      expect(capped.error.length).toBeLessThan(1024)
      // Failure semantics: the head still says what happened.
      expect(capped.error).toContain("Command timed out after 2.0m.")
      expect(capped.error).toContain("Full content saved to:")
      // The tail is gone from the visible result…
      expect(capped.error).not.toContain("line-3999")
      // …but nothing is lost: the prose pointer names the full text.
      const pointer = /Full content saved to: (.+?)\n/.exec(capped.error)?.[1]
      expect(pointer).toBeDefined()
      expect(await Bun.file(pointer!).text()).toBe(error)
    } finally {
      cleanup()
    }
  })

  test("a small failure is returned untouched", () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const result = { ok: false as const, error: "Command is empty." }
      expect(truncateOutput(result, cwd, "bash")).toBe(result)
    } finally {
      cleanup()
    }
  })

  test("the boundary is around the text, not the flag, at the threshold", () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const atLimit = { ok: false as const, error: "x".repeat(THRESHOLD) }
      expect(truncateOutput(atLimit, cwd, "bash")).toBe(atLimit)

      const overLimit = truncateOutput({ ok: false, error: "y".repeat(THRESHOLD + 1) }, cwd, "bash")
      expect(overLimit.ok).toBe(false)
      if (overLimit.ok) throw new Error("unreachable")
      expect(overLimit.error).toContain("Full content saved to:")
    } finally {
      cleanup()
    }
  })

  test("a large failure reaches durable history bounded and failed", async () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const session = sess(cwd)
      const big = `Command timed out after 2.0m.\nPartial output:\n${"p".repeat(9000)}`
      const tools = new Map<string, Tool>([["bigfail", fixedTool({ ok: false, error: big })]])
      const assistant = session.appendAssistant(
        [{ type: "tool_call", toolCallId: "call_big", toolName: "bigfail", input: {} }],
        { finishReason: "tool_call" },
      )

      await executeTool(session, tools, assistant, "bigfail", "call_big", {}, { iteration: 0 })

      const result = session.findToolResult("call_big")
      expect(result?.output.type).toBe("tool_error")
      if (result?.output.type !== "tool_error") throw new Error("unreachable")
      expect(result.output.text.length).toBeLessThan(1024)
      expect(result.output.text).toContain("Command timed out after 2.0m.")
      expect(result.output.text).toContain("Full content saved to:")
      expect(session.ledger.get("call_big")?.status).toBe("failed")

      // The model-visible projection is bounded too.
      const projected = projectedResults(session)
      const visible = projected[0].output
      expect(visible.type).toBe("tool_error")
      if (visible.type !== "tool_error") throw new Error("unreachable")
      expect(visible.text.length).toBeLessThan(1024)
    } finally {
      cleanup()
    }
  })

  test("successful truncation is unchanged", () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const data = "x".repeat(8000)
      const capped = truncateOutput({ ok: true, data }, cwd, "bash")
      expect(capped.ok).toBe(true)
      if (!capped.ok) throw new Error("unreachable")
      expect(capped.data.length).toBeLessThan(1024)
      expect(capped.affordances?.externalizedAt).toBeDefined()
    } finally {
      cleanup()
    }
  })

  test("the read self-cap exemption is unchanged: executeTool does not re-cap read", async () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const session = sess(cwd)
      const raw = "r".repeat(5000) // larger than the canonical cap
      const tools = new Map<string, Tool>([["read", dataTool(raw)]])
      const assistant = session.appendAssistant(
        [{ type: "tool_call", toolCallId: "call_read", toolName: "read", input: {} }],
        { finishReason: "tool_call" },
      )

      await executeTool(session, tools, assistant, "read", "call_read", {}, { iteration: 0 })

      const result = session.findToolResult("call_read")
      expect(result?.output.type).toBe("text")
      if (result?.output.type !== "text") throw new Error("unreachable")
      // Not routed through truncateOutput — the read tool owns its own cap.
      expect(result.output.text).toBe(raw)
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// P0-2 — per-invocation affordance identity
// ---------------------------------------------------------------------------

const TWO_CALLS: ModelAssistantPart[] = [
  { type: "tool_call", toolCallId: "call_a", toolName: "bigA", input: {} },
  { type: "tool_call", toolCallId: "call_b", toolName: "bigB", input: {} },
]

describe("P0-2 — affordances are per invocation", () => {
  test("Case A — two spilling calls keep their own spill file", async () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const session = sess(cwd)
      const a = `alpha\n${"a".repeat(6000)}`
      const b = `beta\n${"b".repeat(6000)}`
      const tools = new Map<string, Tool>([["bigA", dataTool(a)], ["bigB", dataTool(b)]])

      const assistant = session.appendAssistant([...TWO_CALLS], { finishReason: "tool_call" })
      await executeTool(session, tools, assistant, "bigA", "call_a", {}, { iteration: 0 })
      await executeTool(session, tools, assistant, "bigB", "call_b", {}, { iteration: 0 })

      const msg = toolMessage(session)
      const pathA = msg.affordances?.call_a?.externalizedAt
      const pathB = msg.affordances?.call_b?.externalizedAt
      expect(pathA).toBeDefined()
      expect(pathB).toBeDefined()
      expect(pathA).not.toBe(pathB)

      // Cross-check contents, not just filenames.
      expect(await Bun.file(pathA!).text()).toBe(a)
      expect(await Bun.file(pathB!).text()).toBe(b)

      // Projection binds each result to its own file.
      session.pushUser("again")
      const results = projectedResults(session)
      expect(markerOf(results[0])?.spillPath).toBe(pathA)
      expect(markerOf(results[1])?.spillPath).toBe(pathB)
    } finally {
      cleanup()
    }
  })

  test("Case B — a non-spilling sibling inherits nothing", async () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const session = sess(cwd)
      const tools = new Map<string, Tool>([
        ["bigA", dataTool("z".repeat(6000))],
        ["bigB", dataTool("tiny")],
      ])
      const assistant = session.appendAssistant([...TWO_CALLS], { finishReason: "tool_call" })
      await executeTool(session, tools, assistant, "bigA", "call_a", {}, { iteration: 0 })
      await executeTool(session, tools, assistant, "bigB", "call_b", {}, { iteration: 0 })

      const msg = toolMessage(session)
      expect(msg.affordances?.call_a?.externalizedAt).toBeDefined()
      expect(msg.affordances?.call_b).toBeUndefined()

      session.pushUser("again")
      const results = projectedResults(session)
      expect(markerOf(results[0])?.spillPath).toBeDefined()
      // Absence stays absence: call_b must not inherit call_a's recovery.
      expect(markerOf(results[1])?.spillPath).toBeUndefined()
      expect(markerOf(results[1])?.resumeOffset).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("Case C — two read-style results keep their own resume offset", () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const session = sess(cwd)
      session.pushUser("t1")
      const assistant = session.appendAssistant(
        [
          { type: "tool_call", toolCallId: "r1", toolName: "read", input: {} },
          { type: "tool_call", toolCallId: "r2", toolName: "read", input: {} },
        ],
        { finishReason: "tool_call" },
      )
      const msg = session.toolResultMessageFor(assistant)
      session.appendToolResult(msg, { toolCallId: "r1", toolName: "read", output: { type: "text", text: "one".repeat(500) } })
      session.appendToolResult(msg, { toolCallId: "r2", toolName: "read", output: { type: "text", text: "two".repeat(500) } })
      session.markAffordances(msg, "r1", { resumeOffset: 11 })
      session.markAffordances(msg, "r2", { resumeOffset: 22 })
      session.pushUser("t2")

      const results = projectedResults(session)
      expect(markerOf(results[0])?.resumeOffset).toBe(11)
      expect(markerOf(results[1])?.resumeOffset).toBe(22)
    } finally {
      cleanup()
    }
  })

  test("Case D — per-result identity survives persistence", () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const session = sess(cwd)
      const assistant = session.appendAssistant(
        [
          { type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} },
          { type: "tool_call", toolCallId: "c2", toolName: "bash", input: {} },
        ],
        { finishReason: "tool_call" },
      )
      const msg = session.toolResultMessageFor(assistant)
      session.appendToolResult(msg, { toolCallId: "c1", toolName: "bash", output: { type: "text", text: "one".repeat(500) } })
      session.appendToolResult(msg, { toolCallId: "c2", toolName: "bash", output: { type: "text", text: "two".repeat(500) } })
      session.markAffordances(msg, "c1", { externalizedAt: "/spill/one.txt" })
      session.markAffordances(msg, "c2", { resumeOffset: 7 })
      session.pushUser("t2")

      const reloaded = Session.fromJSON(session.toJSON())
      const reloadedMsg = reloaded.messages.find(m => m.role === "tool")
      if (reloadedMsg?.role !== "tool") throw new Error("expected a tool message")
      expect(reloadedMsg.affordances).toEqual({
        c1: { externalizedAt: "/spill/one.txt" },
        c2: { resumeOffset: 7 },
      })

      const results = projectedResults(reloaded)
      expect(markerOf(results[0])?.spillPath).toBe("/spill/one.txt")
      expect(markerOf(results[1])?.resumeOffset).toBe(7)
    } finally {
      cleanup()
    }
  })

  test("recording one result's affordance merges within its key, never across keys", () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const session = sess(cwd)
      const assistant = session.appendAssistant(
        [
          { type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} },
          { type: "tool_call", toolCallId: "c2", toolName: "bash", input: {} },
        ],
        { finishReason: "tool_call" },
      )
      const msg = session.toolResultMessageFor(assistant)
      session.markAffordances(msg, "c1", { externalizedAt: "/spill/one.txt" })
      session.markAffordances(msg, "c2", { externalizedAt: "/spill/two.txt" })
      // A later declaration for c1 merges into c1 alone.
      session.markAffordances(msg, "c1", { resumeOffset: 7 })

      expect(msg.affordances).toEqual({
        c1: { externalizedAt: "/spill/one.txt", resumeOffset: 7 },
        c2: { externalizedAt: "/spill/two.txt" },
      })
    } finally {
      cleanup()
    }
  })

  test("three calls, only the middle spills", () => {
    const { cwd, cleanup } = tempCwd()
    try {
      const session = sess(cwd)
      session.pushUser("t1")
      const assistant = session.appendAssistant(
        [
          { type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} },
          { type: "tool_call", toolCallId: "m", toolName: "bash", input: {} },
          { type: "tool_call", toolCallId: "c3", toolName: "bash", input: {} },
        ],
        { finishReason: "tool_call" },
      )
      const msg = session.toolResultMessageFor(assistant)
      for (const id of ["c1", "m", "c3"]) {
        session.appendToolResult(msg, { toolCallId: id, toolName: "bash", output: { type: "text", text: `${id}`.repeat(400) } })
      }
      session.markAffordances(msg, "m", { externalizedAt: "/spill/m.txt" })
      session.pushUser("t2")

      const results = projectedResults(session)
      expect(markerOf(results[0])?.spillPath).toBeUndefined()
      expect(markerOf(results[1])?.spillPath).toBe("/spill/m.txt")
      expect(markerOf(results[2])?.spillPath).toBeUndefined()
    } finally {
      cleanup()
    }
  })
})
