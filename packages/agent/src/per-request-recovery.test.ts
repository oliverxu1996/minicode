/**
 * Per-request recovery boundary.
 *
 * The invariant: before every actual `model.stream`, the existing recovery
 * mechanism has reconciled any execution boundary it is responsible for. This
 * matters because steering can persist an assistant `tool_call` without a
 * result and then continue straight to the next request — state created after
 * the run-start recovery, which only a per-request boundary can catch.
 *
 * `needsRecovery()` stays advisory (see the D5 contract in
 * `session-boundary.test.ts`); the boundary, not the latch, guarantees
 * reconciliation.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MiniCode } from "./minicode"
import { Session } from "./session/session"
import { FakeModel, textResponse, toolCallResponse } from "./testing"
import type { ModelRequest } from "@minicode/model"

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "minicode-per-request-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Tool-call ids in a recorded request that have no matching tool result. */
function unpairedIn(request: ModelRequest): string[] {
  const calls: string[] = []
  const results: string[] = []
  for (const m of request.messages) {
    if (m.role === "assistant") {
      for (const p of m.content) if (p.type === "tool_call") calls.push(p.toolCallId)
    } else if (m.role === "tool") {
      for (const r of m.content) results.push(r.toolCallId)
    }
  }
  return calls.filter(id => !results.includes(id))
}

function resultIds(session: Session, toolCallId: string): number {
  return session.messages
    .filter(m => m.role === "tool")
    .flatMap(m => (m as { content: readonly { toolCallId: string }[] }).content)
    .filter(r => r.toolCallId === toolCallId).length
}

// ---------------------------------------------------------------------------
// AC2/AC4/F — ordering: recover immediately precedes every model.stream
// ---------------------------------------------------------------------------

describe("per-request recovery ordering", () => {
  test("every model.stream is immediately preceded by a recover call", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const sessionsDir = join(dir, "sessions")
      const model = new FakeModel([
        toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }]),
        textResponse("final after steering"),
      ])
      const agent = new MiniCode({ sessionsDir, model })
      const session = agent.createSession(join(dir, "ws"))

      const order: string[] = []
      const origRecover = session.recover.bind(session)
      ;(session as unknown as { recover: typeof session.recover }).recover = async (hooks) => {
        order.push("recover")
        return origRecover(hooks)
      }
      const origStream = model.stream.bind(model)
      ;(model as unknown as { stream: typeof model.stream }).stream = (request: ModelRequest) => {
        order.push("stream")
        return origStream(request)
      }

      session.steer("redirect")
      await agent.run(session, "task")

      // At least two requests (the steered continuation is the second).
      expect(order.filter(o => o === "stream").length).toBeGreaterThanOrEqual(2)
      // No stream is ever without an immediately preceding recover.
      order.forEach((entry, i) => {
        if (entry === "stream") expect(order[i - 1]).toBe("recover")
      })
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC1/A — tool-only response followed by steering
// ---------------------------------------------------------------------------

describe("tool-only response followed by steering", () => {
  test("the next request carries the reconciled result, not a bare tool call", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const sessionsDir = join(dir, "sessions")
      const model = new FakeModel([
        toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }]),
        textResponse("final after steering"),
      ])
      const agent = new MiniCode({ sessionsDir, model })
      const session = agent.createSession(join(dir, "ws"))

      // Steer queued before the run: the tool-only response is captured, the
      // steer breaks the stream before the tool runs.
      session.steer("actually do something else")
      const events: string[] = []
      const result = await agent.run(session, "original task", { onEvent: e => events.push(e.type) })

      expect(result.finishReason).toBe("stop")
      // The captured call is persisted…
      const partial = session.messages[1]
      if (partial.role !== "assistant") throw new Error("expected assistant")
      expect(partial.content.some(p => p.type === "tool_call" && p.toolCallId === "call_1")).toBe(true)
      // …and the next request is paired.
      const second = model.requests[1]
      expect(unpairedIn(second)).toEqual([])
      expect(events).toContain("recovery")
      // The unknown outcome was recorded, never a fabricated success.
      expect(session.ledger.get("call_1")?.status).toBe("failed")
      expect(resultIds(session, "call_1")).toBe(1)
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC5/B — multiple unresolved calls reconciled independently
// ---------------------------------------------------------------------------

describe("multiple unresolved calls", () => {
  test("each toolCallId is reconciled independently at the boundary", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const sessionsDir = join(dir, "sessions")
      const model = new FakeModel([textResponse("done")])
      const agent = new MiniCode({ sessionsDir, model })
      const session = agent.createSession(join(dir, "ws"))

      // The durable state a steering interruption can leave: an assistant turn
      // with two calls, no results, no ledger entries.
      await session.replaceMessages([
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: [
            { type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} },
            { type: "tool_call", toolCallId: "c2", toolName: "read", input: {} },
          ],
        },
      ])

      await agent.run(session, "continue")

      const request = model.requests[0]
      expect(unpairedIn(request)).toEqual([])
      expect(session.ledger.get("c1")?.status).toBe("failed")
      expect(session.ledger.get("c2")?.status).toBe("failed")
      expect(resultIds(session, "c1")).toBe(1)
      expect(resultIds(session, "c2")).toBe(1)
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC6/C — steering without a tool call is unchanged
// ---------------------------------------------------------------------------

describe("steering without a tool call", () => {
  test("no recovery event and no extra recovery work", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const sessionsDir = join(dir, "sessions")
      const model = new FakeModel([
        textResponse("partial answer"),
        textResponse("final after steering"),
      ])
      const agent = new MiniCode({ sessionsDir, model })
      const session = agent.createSession(join(dir, "ws"))
      session.steer("redirect")

      const events: string[] = []
      const result = await agent.run(session, "task", { onEvent: e => events.push(e.type) })

      expect(result.finishReason).toBe("stop")
      expect(events.filter(e => e === "recovery")).toHaveLength(0)
      expect(session.messages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC7/E — an already-completed call is never re-finalized
// ---------------------------------------------------------------------------

describe("completed invocation is not duplicated by recovery", () => {
  test("recovery over a paired, terminal invocation is a no-op", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const session = Session.create({ cwd: dir })
      session.onCheckpoint(async () => {})
      const assistant = session.appendAssistant(
        [{ type: "tool_call", toolCallId: "done", toolName: "bash", input: {} }],
        { finishReason: "tool_call" },
      )
      const toolMsg = session.toolResultMessageFor(assistant)
      session.appendToolResult(toolMsg, {
        toolCallId: "done",
        toolName: "bash",
        output: { type: "text", text: "ok" },
      })
      session.ledger.pending({ toolCallId: "done", name: "bash", input: {} })
      session.ledger.running("done")
      session.ledger.finished("done", "succeeded")

      const report = await session.recover()
      expect(report.recovered).toBe(false)
      expect(resultIds(session, "done")).toBe(1)
      expect(session.ledger.get("done")?.status).toBe("succeeded")
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC8/G — recovery idempotence
// ---------------------------------------------------------------------------

describe("recovery idempotence at the boundary", () => {
  test("recover twice does not duplicate results, ledger, or events", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const session = Session.create({ cwd: dir })
      session.onCheckpoint(async () => {})
      session.appendAssistant(
        [{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} }],
        { finishReason: "tool_call" },
      )

      const first = await session.recover()
      expect(first.recovered).toBe(true)
      expect(resultIds(session, "c1")).toBe(1)

      const second = await session.recover()
      expect(second.recovered).toBe(false)
      expect(resultIds(session, "c1")).toBe(1)
      expect(session.ledger.get("c1")?.status).toBe("failed")
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// AC9/I — in-process and reload produce equivalent paired requests
// ---------------------------------------------------------------------------

describe("in-process and reload equivalence", () => {
  test("both continuations send a paired request", async () => {
    const { dir, cleanup } = tempDir()
    try {
      const sessionsDir = join(dir, "sessions")

      const buildInterrupted = async (ws: string): Promise<Session> => {
        const agent = new MiniCode({
          sessionsDir,
          model: new FakeModel([
            toolCallResponse([{ toolCallId: "c1", toolName: "bash", input: {} }]),
            textResponse("unused"),
          ]),
        })
        const session = agent.createSession(ws)
        await session.replaceMessages([
          { role: "user", content: "task" },
          { role: "assistant", content: [{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} }] },
        ])
        return session
      }

      // In-process continuation.
      const inProc = await buildInterrupted(join(dir, "ws-a"))
      const modelInProc = new FakeModel([textResponse("ok")])
      const agentInProc = new MiniCode({ sessionsDir, model: modelInProc })
      await agentInProc.run(inProc, "continue")

      // Reload continuation.
      const reloaded = await buildInterrupted(join(dir, "ws-b"))
      await reloaded.checkpoint()
      const modelReload = new FakeModel([textResponse("ok")])
      const agentReload = new MiniCode({ sessionsDir, model: modelReload })
      const fresh = await agentReload.loadSession(reloaded.id)
      await agentReload.run(fresh, "continue")

      expect(unpairedIn(modelInProc.requests[0])).toEqual([])
      expect(unpairedIn(modelReload.requests[0])).toEqual([])
    } finally {
      cleanup()
    }
  })
})
