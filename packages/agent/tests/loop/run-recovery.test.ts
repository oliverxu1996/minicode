/**
 * Run recovery and startup fault isolation.
 *
 * C1 — every model-request boundary reconciles interruptible execution state
 *      first (the run loop and compaction requests alike).
 * C2 — once `beginRun` succeeds, no initialization/event failure can strand the
 *      session as active.
 * C3 — hook-less recovery reconciles a pending invocation to an unknown
 *      terminal outcome without terminalizing it twice.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelMessage } from "@minicode/model"
import { Compactor } from "../../src/context/compaction"
import { MiniCode } from "../../src/minicode"
import { Session, UNKNOWN_OUTCOME_ERROR } from "../../src/session/session"
import type { ModelIdentity } from "../../src/session/types"
import { CODING_TOOLS } from "../../src/tools"
import { FakeModel, textResponse, toolCallResponse } from "../support/testing"

const MODEL: ModelIdentity = {
  id: "test-model",
  name: "Test Model",
  protocol: "openai",
  model: "test-model",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
}

interface Harness {
  dir: string
  sessionsDir: string
  agent: MiniCode
  cleanup: () => void
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "minicode-run-recovery-"))
  const sessionsDir = join(dir, "sessions")
  return {
    dir,
    sessionsDir,
    agent: new MiniCode({ sessionsDir, model: new FakeModel([textResponse("ok")]) }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function sess(cwd: string): Session {
  const session = Session.create({ cwd })
  session.onCheckpoint(async () => {})
  return session
}

const resultsFor = (session: Session, toolCallId: string) =>
  session.messages
    .filter(m => m.role === "tool")
    .flatMap(m => (m as { content: readonly { toolCallId: string }[] }).content)
    .filter(r => r.toolCallId === toolCallId)

/** True when the model request at `index` carries a tool result for `toolCallId`. */
function requestHasResult(model: FakeModel, index: number, toolCallId: string): boolean {
  const request = model.requests[index]
  if (request === undefined) return false
  return request.messages.some(
    m => m.role === "tool" && m.content.some(r => r.toolCallId === toolCallId),
  )
}

/** True when the model request at `index` carries an assistant tool call. */
function requestHasCall(model: FakeModel, index: number, toolCallId: string): boolean {
  const request = model.requests[index]
  if (request === undefined) return false
  return request.messages.some(
    m => m.role === "assistant" && m.content.some(p => p.type === "tool_call" && p.toolCallId === toolCallId),
  )
}

// ---------------------------------------------------------------------------
// C1 — recovery at model-request boundaries
// ---------------------------------------------------------------------------

describe("C1 — recovery before model requests", () => {
  test("an idle dangling call is reconciled before the next model request", async () => {
    const h = harness()
    try {
      const session = h.agent.createSession(join(h.dir, "ws"))
      await session.replaceMessages([
        { role: "user", content: "task" },
        { role: "assistant", content: [{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} }] },
      ])
      // D5: the latch stays advisory; the dangling call does not set it.
      expect(session.needsRecovery()).toBe(false)

      const model = new FakeModel([textResponse("done")])
      const agent = new MiniCode({ sessionsDir: h.sessionsDir, model })
      const events: string[] = []
      await agent.run(session, "next", { onEvent: e => events.push(e.type) })

      // The request carried the unresolved call *and* its injected outcome.
      expect(requestHasCall(model, 0, "c1")).toBe(true)
      expect(requestHasResult(model, 0, "c1")).toBe(true)
      expect(events).toContain("recovery")
      expect(session.ledger.get("c1")?.status).toBe("failed")
      expect(resultsFor(session, "c1")).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test("in-process interrupted continuation reconciles like a reload continuation", async () => {
    const h = harness()
    try {
      const sessionsDir = h.sessionsDir
      const aborting = new FakeModel([
        toolCallResponse([{ toolCallId: "c1", toolName: "bash", input: { command: "echo hi" } }]),
        textResponse("unused"),
      ])
      const agent = new MiniCode({ sessionsDir, model: aborting })
      const session = agent.createSession(join(h.dir, "ws"))

      // Interrupt after the assistant tool-call turn is durably persisted but
      // before the tool runs.
      const ctrl = new AbortController()
      await agent.run(session, "task", {
        signal: ctrl.signal,
        onEvent: e => { if (e.type === "model_response") ctrl.abort() },
      })
      expect(session.status).toBe("interrupted")
      expect(resultsFor(session, "c1")).toHaveLength(0)

      // Path B: reload, then continue.
      const modelReload = new FakeModel([textResponse("reloaded")])
      const agentReload = new MiniCode({ sessionsDir, model: modelReload })
      const reloaded = await agentReload.loadSession(session.id)
      const eventsReload: string[] = []
      await agentReload.run(reloaded, "continue", { onEvent: e => eventsReload.push(e.type) })

      // Path A: continue in-process on the same object.
      const modelInProc = new FakeModel([textResponse("in-process")])
      const agentInProc = new MiniCode({ sessionsDir, model: modelInProc })
      const eventsInProc: string[] = []
      await agentInProc.run(session, "continue", { onEvent: e => eventsInProc.push(e.type) })

      for (const [model, events] of [[modelReload, eventsReload], [modelInProc, eventsInProc]] as const) {
        expect(events).toContain("recovery")
        expect(requestHasResult(model, 0, "c1")).toBe(true)
      }
    } finally {
      h.cleanup()
    }
  })

  test("already-reconciled invocations are not duplicated, and recover is idempotent", async () => {
    const h = harness()
    try {
      const session = sess(h.dir)
      session.appendAssistant(
        [{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} }],
        { finishReason: "tool_call" },
      )

      const first = await session.recover()
      expect(first.recovered).toBe(true)
      expect(first.unknownOutcome).toHaveLength(1)

      const second = await session.recover()
      expect(second.recovered).toBe(false)
      expect(resultsFor(session, "c1")).toHaveLength(1)
      expect(session.ledger.get("c1")?.status).toBe("failed")

      const third = await session.recover()
      expect(third.recovered).toBe(false)
      expect(resultsFor(session, "c1")).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  test("two dangling calls each receive their own outcome", async () => {
    const h = harness()
    try {
      const session = sess(h.dir)
      session.appendAssistant(
        [
          { type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} },
          { type: "tool_call", toolCallId: "c2", toolName: "read", input: {} },
        ],
        { finishReason: "tool_call" },
      )

      const report = await session.recover()
      expect(report.recovered).toBe(true)
      expect(report.unknownOutcome.map(u => u.toolCallId).sort()).toEqual(["c1", "c2"])
      expect(resultsFor(session, "c1")).toHaveLength(1)
      expect(resultsFor(session, "c2")).toHaveLength(1)
      expect(session.ledger.get("c1")?.status).toBe("failed")
      expect(session.ledger.get("c2")?.status).toBe("failed")
    } finally {
      h.cleanup()
    }
  })

  test("a clean session emits no recovery event and makes no note", async () => {
    const h = harness()
    try {
      const session = h.agent.createSession(join(h.dir, "ws"))
      const model = new FakeModel([textResponse("done")])
      const agent = new MiniCode({ sessionsDir: h.sessionsDir, model })
      const events: string[] = []
      await agent.run(session, "hello", { onEvent: e => events.push(e.type) })

      expect(events).not.toContain("recovery")
      expect(session.takeRecoveryNote()).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  test("reconciled state is persisted and survives reload", async () => {
    const h = harness()
    try {
      const session = h.agent.createSession(join(h.dir, "ws"))
      await session.replaceMessages([
        { role: "user", content: "task" },
        { role: "assistant", content: [{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} }] },
      ])
      const agent = new MiniCode({ sessionsDir: h.sessionsDir, model: new FakeModel([textResponse("done")]) })
      await agent.run(session, "next")

      const reloaded = await new MiniCode({ sessionsDir: h.sessionsDir }).loadSession(session.id)
      expect(resultsFor(reloaded, "c1")).toHaveLength(1)
      expect(reloaded.ledger.get("c1")?.status).toBe("failed")
      expect(reloaded.needsRecovery()).toBe(false)
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// C2 — run-start fault isolation
// ---------------------------------------------------------------------------

describe("C2 — run-start fault isolation", () => {
  test("a throwing run_start consumer terminalizes the run once and leaves the session usable", async () => {
    const h = harness()
    try {
      const session = h.agent.createSession(join(h.dir, "ws"))
      const model = new FakeModel([textResponse("second run")])
      const agent = new MiniCode({ sessionsDir: h.sessionsDir, model })
      const events: string[] = []

      const result = await agent.run(session, "first", {
        onEvent: e => {
          events.push(e.type)
          if (e.type === "run_start") throw new Error("renderer blew up")
        },
      })

      // The consumer failure is the run's outcome — never a success, never silent.
      expect(result.finishReason).toBe("error")
      expect(result.error).toContain("renderer blew up")
      // Exactly one run_start delivery and one terminal run_end.
      expect(events.filter(t => t === "run_start")).toHaveLength(1)
      expect(events.filter(t => t === "run_end")).toHaveLength(1)
      // The run is terminal exactly once and the session is not stranded.
      expect(session.status).toBe("idle")
      expect(session.runs).toHaveLength(1)
      expect(session.runs[0]!.finishedAt).toBeDefined()
      expect(session.runs[0]!.finishReason).toBe("error")
      expect(session.runs[0]!.error).toContain("renderer blew up")

      // The next run starts normally.
      const second = await agent.run(session, "second")
      expect(second.finishReason).toBe("stop")
      expect(session.runs).toHaveLength(2)
    } finally {
      h.cleanup()
    }
  })

  test("a failed beginRun checkpoint rolls back all in-memory mutations", async () => {
    const h = harness()
    try {
      const session = Session.create({ cwd: h.dir })
      let fail = true
      session.onCheckpoint(async () => {
        if (fail) throw new Error("disk full")
      })

      const statusBefore = session.status
      const updatedBefore = session.updatedAt

      await expect(session.beginRun(MODEL)).rejects.toThrow("disk full")

      expect(session.status).toBe(statusBefore)
      expect(session.runs).toHaveLength(0)
      expect(session.updatedAt).toBe(updatedBefore)

      // The active-run latch was cleared: a later run can start.
      fail = false
      const run = await session.beginRun(MODEL)
      expect(session.status).toBe("running")
      expect(session.runs).toHaveLength(1)
      expect(session.runs[0]!.id).toBe(run.id)
    } finally {
      h.cleanup()
    }
  })

  test("normal successful lifecycle is unchanged", async () => {
    const h = harness()
    try {
      const session = h.agent.createSession(join(h.dir, "ws"))
      const model = new FakeModel([textResponse("done")])
      const agent = new MiniCode({ sessionsDir: h.sessionsDir, model })
      const events: string[] = []
      const result = await agent.run(session, "task", { onEvent: e => events.push(e.type) })

      expect(result.finishReason).toBe("stop")
      expect(events[0]).toBe("run_start")
      expect(events[events.length - 1]).toBe("run_end")
      expect(session.status).toBe("idle")
      expect(session.runs).toHaveLength(1)
      expect(session.runs[0]!.finishReason).toBe("stop")
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// C3 — hook-less recovery
// ---------------------------------------------------------------------------

describe("C3 — hook-less recovery", () => {
  test("a pending entry with a matching call and no executeTool terminalizes once", async () => {
    const h = harness()
    try {
      const session = sess(h.dir)
      session.appendAssistant(
        [{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} }],
        { finishReason: "tool_call" },
      )
      session.ledger.pending({ toolCallId: "c1", name: "bash", input: {} })

      // No `executeTool`: reconcile to an unknown terminal outcome, not re-execute.
      const report = await session.recover({ tools: CODING_TOOLS })
      expect(report.recovered).toBe(true)
      expect(session.ledger.get("c1")?.status).toBe("failed")
      expect(session.ledger.get("c1")?.note).toBe(UNKNOWN_OUTCOME_ERROR)
      expect(resultsFor(session, "c1")).toHaveLength(1)

      // Repeated recovery is safe and adds nothing.
      const again = await session.recover({ tools: CODING_TOOLS })
      expect(again.recovered).toBe(false)
      expect(resultsFor(session, "c1")).toHaveLength(1)
      expect(session.ledger.get("c1")?.status).toBe("failed")
    } finally {
      h.cleanup()
    }
  })

  test("a true orphan pending entry (no assistant call) is still reconciled", async () => {
    const h = harness()
    try {
      const session = sess(h.dir)
      session.ledger.pending({ toolCallId: "orphan", name: "bash", input: {} })

      const report = await session.recover()
      expect(report.recovered).toBe(true)
      expect(session.ledger.get("orphan")?.status).toBe("failed")
    } finally {
      h.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Manual /compact — compaction is a model-request boundary
// ---------------------------------------------------------------------------

describe("manual /compact recovers before its model request", () => {
  test("a dangling call is reconciled before the summarization request", async () => {
    const h = harness()
    try {
      const session = sess(h.dir)
      session.pushUser("x".repeat(12_000))
      session.appendAssistant(
        [{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} }],
        { finishReason: "tool_call" },
      )
      session.pushUser("y".repeat(4_000))
      // A trailing turn so the last message is not a user message; the
      // dangling call sits inside the compactable region.
      session.appendAssistant([{ type: "text", text: "working" }], {})

      const model = new FakeModel([textResponse("summary")])
      const outcome = await new Compactor(model, 1000).compact(session)

      expect(outcome.status).toBe("compacted")
      // The summarization request already carried the reconciled result.
      const request = model.requests[0]
      if (request === undefined) throw new Error("expected a summarization request")
      const carriedResult = request.messages.some(
        (m: ModelMessage) => m.role === "tool" && m.content.some(r => r.toolCallId === "c1"),
      )
      expect(carriedResult).toBe(true)
      expect(session.ledger.get("c1")?.status).toBe("failed")
    } finally {
      h.cleanup()
    }
  })

  test("compaction of clean history is unchanged", async () => {
    const h = harness()
    try {
      const session = sess(h.dir)
      session.pushUser("x".repeat(12_000))
      session.pushUser("y".repeat(4_000))
      session.appendAssistant([{ type: "text", text: "working" }], {})

      const model = new FakeModel([textResponse("summary")])
      const outcome = await new Compactor(model, 1000).compact(session)
      expect(outcome.status).toBe("compacted")
    } finally {
      h.cleanup()
    }
  })
})
