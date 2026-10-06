/**
 * The durable Session: its read-only history surface, its mutable history
 * operations, its run lifecycle, and its crash/reload behaviour.
 *
 * The history-boundary test is type-level: its `@ts-expect-error` lines must
 * FAIL to compile, which `bun run typecheck` enforces. The closure is never
 * invoked.
 *
 * "Durable" is asserted the only way that can tell memory from disk: by
 * discarding the in-memory object and reloading through a fresh runtime root.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Model } from "@minicode/model"
import { executeTool } from "../../src/loop/execute"
import { MiniCode } from "../../src/minicode"
import { toolDurationMs } from "../../src/session/ledger"
import { Session, UNKNOWN_OUTCOME_ERROR } from "../../src/session/session"
import { SessionStore } from "../../src/session/store"
import type { ModelIdentity } from "../../src/session/types"
import { CODING_TOOLS } from "../../src/tools"
import { FakeModel, textResponse, toolCallResponse } from "../support/testing"

/** A model identity for runs a test starts directly (crash simulation). */
const RUN_MODEL: ModelIdentity = {
  id: "test-model",
  name: "Test Model",
  protocol: "openai",
  model: "test-model",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "minicode-session-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

interface Harness {
  /** The temp workspace root; sessions live at `join(dir, "sessions")`. */
  dir: string
  agent: MiniCode
  /** Simulates a crash-restart: persists the live session (the crash-time
   *  snapshot), then loads it through a fresh runtime root with an empty
   *  session cache. */
  reloadAsNewProcess(session: Session): Promise<Session>
  cleanup(): void
}

function harness(model?: Model): Harness {
  const { dir, cleanup } = tempDir()
  const sessionsDir = join(dir, "sessions")
  const agent = new MiniCode({ sessionsDir, model })
  return {
    dir,
    agent,
    reloadAsNewProcess: async (session: Session) => {
      await session.checkpoint()
      const fresh = new MiniCode({ sessionsDir, model })
      return fresh.loadSession(session.id)
    },
    cleanup,
  }
}

/** Never invoked: its body exists only so `tsc` checks the read-only boundary. */
function typeOnly(fn: () => void): void {
  void fn
}

function sess(): Session {
  const session = Session.create({ cwd: "/tmp/minicode-boundary-test" })
  session.onCheckpoint(async () => {})
  return session
}

describe("F2 — Session history external read boundary", () => {
  test("the collection and its message fields are read-only through the public API", () => {
    const session = sess()
    session.pushUser("hi")

    typeOnly(() => {
      // @ts-expect-error the collection is a read-only view
      session.messages.push(session.messages[0])
      // @ts-expect-error length is read-only
      session.messages.length = 0
      // @ts-expect-error indexes are read-only
      session.messages[0] = session.messages[0]
      // @ts-expect-error messages is a getter-only view
      session.messages = []
      // @ts-expect-error message status is read-only
      session.messages[0].status = "complete"
      // @ts-expect-error message timestamp is read-only
      session.messages[0].timestamp = 0
    })

    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].content).toBe("hi")
  })

  test("legitimate Session history operations still work", async () => {
    const session = sess()
    const user = session.pushUser("hi")
    expect(user.role).toBe("user")

    const assistant = session.appendAssistant([{ type: "text", text: "hello" }], { finishReason: "stop" })
    expect(assistant.role).toBe("assistant")

    const toolMsg = session.toolResultMessageFor(assistant)
    session.appendToolResult(toolMsg, {
      toolCallId: "c1",
      toolName: "bash",
      output: { type: "text", text: "ok" },
    })
    session.markFailureEvidence(toolMsg)
    session.markAffordances(toolMsg, "c1", { externalizedAt: "/tmp/out", resumeOffset: 10 })

    expect(session.messages.map(m => m.role)).toEqual(["user", "assistant", "tool"])
    const tool = session.messages[2]
    if (tool.role !== "tool") throw new Error("expected a tool message")
    expect(tool.content[0].output).toEqual({ type: "text", text: "ok" })
    expect(tool.failureEvidence).toBe(true)
    expect(tool.affordances).toEqual({ c1: { externalizedAt: "/tmp/out", resumeOffset: 10 } })
    expect(session.findToolResult("c1")?.toolName).toBe("bash")
    expect(session.lastAssistant()?.role).toBe("assistant")
  })

  test("replaceMessages still replaces history and persists", async () => {
    const session = sess()
    let checkpoints = 0
    session.onCheckpoint(async () => {
      checkpoints += 1
    })
    await session.replaceMessages([
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ])
    expect(session.messages.map(m => m.role)).toEqual(["user", "assistant"])
    expect(checkpoints).toBe(1)
  })
})

describe("durable snapshot storage", () => {
  test("the atomic store round-trips snapshots", async () => {
    const { dir, cleanup } = tempDir()
    const store = new SessionStore(join(dir, "store"))
    await store.saveJSON("s1", JSON.stringify({ id: "s1" }))
    const parsed = await store.read("s1") as { id: string }
    expect(parsed.id).toBe("s1")
    expect(await store.list()).toEqual(["s1"])
    cleanup()
  })
})

describe("Crash recovery (V2, AC6/AC7)", () => {
  test("pending tool calls are reissued with the same toolCallId", async () => {
    const { agent, reloadAsNewProcess, cleanup } = harness(new FakeModel([textResponse("done")]))
    const workspace = join(tempDir().dir, `reissue-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    const session = agent.createSession(workspace)
    await session.checkpoint()

    // Simulate a crash after the assistant turn was appended and the call
    // was durably pending, but before it executed.
    const assistant = session.appendAssistant(
      [{ type: "tool_call", toolCallId: "call_1", toolName: "write", input: { filePath: "recovered.txt", content: "data" } }],
      { finishReason: "tool_call" },
    )
    session.toolResultMessageFor(assistant)
    session.ledger.pending({ toolCallId: "call_1", name: "write", input: { filePath: "recovered.txt", content: "data" } })
    await session.checkpoint()

    await session.beginRun(RUN_MODEL) // crash mid-run: beginRun persists 'running'
    const persisted = await reloadAsNewProcess(session)
    expect(persisted.needsRecovery()).toBe(true)
    expect(persisted.status).toBe("interrupted")

    const result = await agent.run(persisted, "continue the task")

    expect(result.finishReason).toBe("stop")
    // The reissued call actually executed against the workspace.
    expect(await Bun.file(join(workspace, "recovered.txt")).exists()).toBe(true)
    expect(persisted.ledger.get("call_1")?.status).toBe("succeeded")
    rmSync(workspace, { recursive: true, force: true })
    cleanup()
  })

  test("running entries with unknown outcome are injected as failures", async () => {
    const { agent, reloadAsNewProcess, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))
    await session.checkpoint()

    const assistant = session.appendAssistant(
      [{ type: "tool_call", toolCallId: "call_1", toolName: "edit", input: { filePath: "x.ts" } }],
      { finishReason: "tool_call" },
    )
    session.toolResultMessageFor(assistant)
    session.ledger.pending({ toolCallId: "call_1", name: "edit", input: { filePath: "x.ts" } })
    session.ledger.running("call_1")

    await session.beginRun(RUN_MODEL) // crash mid-run: beginRun persists 'running'
    const persisted = await reloadAsNewProcess(session)
    await persisted.recover({ tools: CODING_TOOLS })

    const resultMsg = persisted.findToolResult("call_1")
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.output.type).toBe("tool_error")
    if (resultMsg?.output.type === "tool_error") {
      expect(resultMsg.output.text).toBe(UNKNOWN_OUTCOME_ERROR)
    }
    expect(persisted.ledger.get("call_1")?.status).toBe("failed")
    expect(persisted.needsRecovery()).toBe(false)
    expect(persisted.takeRecoveryNote()).toContain("Do NOT assume they completed")
    cleanup()
  })

  test("idempotent tools (read) are reissued, not failed", async () => {
    const { agent, reloadAsNewProcess, cleanup } = harness()
    const workspace = join(tempDir().dir, "ws")
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, "known.txt"), "known content")
    const session = agent.createSession(workspace)
    await session.checkpoint()

    const assistant = session.appendAssistant(
      [{ type: "tool_call", toolCallId: "call_1", toolName: "read", input: { filePath: "known.txt" } }],
      { finishReason: "tool_call" },
    )
    session.toolResultMessageFor(assistant)
    session.ledger.pending({ toolCallId: "call_1", name: "read", input: { filePath: "known.txt" } })
    session.ledger.running("call_1")

    await session.beginRun(RUN_MODEL) // crash mid-run: beginRun persists 'running'
    const persisted = await reloadAsNewProcess(session)
    await persisted.recover({
      tools: CODING_TOOLS,
      executeTool: (s, msg, name, callId, input, opts) =>
        executeTool(s, CODING_TOOLS, msg, name, callId, input, { iteration: 0, reissue: opts?.reissue }),
    })

    expect(persisted.ledger.get("call_1")?.status).toBe("succeeded")
    const result = persisted.findToolResult("call_1")
    expect(result?.output.type).toBe("text")
    rmSync(workspace, { recursive: true, force: true })
    cleanup()
  })

  test("dangling tool-call parts without ledger entries get unknown outcomes", async () => {
    const { agent, reloadAsNewProcess, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))
    await session.checkpoint()

    // Pre-ledger-era style interruption: call part exists, nothing else does.
    session.appendAssistant(
      [{ type: "tool_call", toolCallId: "call_1", toolName: "bash", input: { command: "echo x" } }],
      { finishReason: "tool_call" },
    )
    await session.beginRun(RUN_MODEL) // crash mid-run: beginRun persists 'running'
    const persisted = await reloadAsNewProcess(session)
    await persisted.recover({ tools: CODING_TOOLS })

    const result = persisted.findToolResult("call_1")
    expect(result?.output.type).toBe("tool_error")
    expect(persisted.ledger.get("call_1")?.status).toBe("failed")
    cleanup()
  })

  test("a clean session does not recover", async () => {
    const { agent, reloadAsNewProcess, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))
    await session.checkpoint()

    const persisted = await reloadAsNewProcess(session)
    const report = await persisted.recover()
    expect(report.recovered).toBe(false)
    expect(persisted.takeRecoveryNote()).toBeNull()
    cleanup()
  })
})

describe("tool duration across a restart", () => {
  test("an unknown outcome across a restart manufactures no duration", async () => {
    const { agent, reloadAsNewProcess, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))
    await session.checkpoint()
    const assistant = session.appendAssistant(
      [{ type: "tool_call", toolCallId: "call_1", toolName: "edit", input: { filePath: "x.ts" } }],
      { finishReason: "tool_call" },
    )
    session.toolResultMessageFor(assistant)
    session.ledger.pending({ toolCallId: "call_1", name: "edit", input: { filePath: "x.ts" } })
    session.ledger.running("call_1", { startedAt: 1_000 })

    await session.beginRun(RUN_MODEL) // crash mid-run, after the tool started
    const persisted = await reloadAsNewProcess(session)
    await persisted.recover({ tools: CODING_TOOLS })

    const entry = persisted.ledger.get("call_1")!
    // Existing outcome semantics are untouched…
    expect(entry.status).toBe("failed")
    expect(entry.note).toBe(UNKNOWN_OUTCOME_ERROR)
    // …and the invocation that never finished has no interval to report.
    expect(toolDurationMs(entry)).toBeUndefined()
    cleanup()
  })
})

describe("Usage detail persistence (O1)", () => {
  test("provider cache and reasoning detail survives to the snapshot and reload", async () => {
    const { agent, reloadAsNewProcess, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))
    await session.checkpoint()

    // The provider-reported breakdown, as the model layer carries it, recorded
    // on the run — the one authoritative holder for a run's usage.
    const providerUsage = {
      inputTokens: 1050,
      outputTokens: 20,
      totalTokens: 1070,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      reasoningTokens: 7,
    }
    // Record the provider breakdown through the real run lifecycle, so this
    // tests the durable path a run actually uses rather than mutating the
    // record collection directly.
    const started = await session.beginRun({
      id: "m1",
      name: "model one",
      protocol: "openai",
      model: "gpt",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    })
    await session.finishRun(started.id, {
      aborted: false,
      finishReason: "stop",
      usage: providerUsage,
      modelCalls: 1,
      toolCalls: 0,
    })

    // Through a fresh runtime root, as a restarted process would read it.
    const persisted = await reloadAsNewProcess(session)
    expect(persisted.runs[0]?.usage).toEqual(providerUsage)
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Run lifecycle ownership — the Session is the only owner of run lifecycle
// state. These pin the invariants that direct field writes only ever held by
// convention (single-active-run, terminal immutability, stale/double finish).
// ---------------------------------------------------------------------------

describe("Run lifecycle ownership", () => {
  test("beginRun establishes the active run, record and running status durably", async () => {
    const { agent, reloadAsNewProcess, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))

    const started = await session.beginRun(RUN_MODEL)

    expect(session.status).toBe("running")
    expect(session.runs).toHaveLength(1)
    expect(session.runs[0]!.id).toBe(started.id)
    expect(session.runs[0]!.model).toEqual(RUN_MODEL)
    // Only the facts known at start; no terminal fact is fabricated.
    expect(session.runs[0]).not.toHaveProperty("finishedAt")
    expect(session.runs[0]).not.toHaveProperty("finishReason")

    // Durable as 'running' before execution; a fresh process reads it as
    // 'interrupted' (existing recovery semantics, unchanged).
    const reloaded = await reloadAsNewProcess(session)
    expect(reloaded.status).toBe("interrupted")
    expect(reloaded.runs[0]!.id).toBe(started.id)
    cleanup()
  })

  test("a second beginRun while a run is active is rejected (AC2)", async () => {
    const { agent, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))

    const first = await session.beginRun(RUN_MODEL)
    await expect(session.beginRun(RUN_MODEL)).rejects.toThrow(/already active/)

    // The original run remains authoritative; nothing was appended.
    expect(session.status).toBe("running")
    expect(session.runs).toHaveLength(1)
    expect(session.runs[0]!.id).toBe(first.id)
    cleanup()
  })

  test("finishRun records the terminal outcome, returns to idle, and persists (AC5/AC6)", async () => {
    const { agent, reloadAsNewProcess, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))

    const started = await session.beginRun(RUN_MODEL)
    const finished = await session.finishRun(started.id, {
      aborted: false,
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 3 },
      modelCalls: 2,
      toolCalls: 1,
    })

    expect(session.status).toBe("idle")
    expect(finished.id).toBe(started.id)
    expect(finished.startedAt).toBe(started.startedAt)
    expect(finished.finishReason).toBe("stop")
    expect(finished.usage).toEqual({ inputTokens: 5, outputTokens: 3 })
    expect(finished.modelCalls).toBe(2)
    expect(finished.toolCalls).toBe(1)
    expect(finished.finishedAt).toEqual(expect.any(Number))

    const reloaded = await reloadAsNewProcess(session)
    expect(reloaded.runs).toEqual([finished])
    expect(reloaded.status).toBe("idle")
    cleanup()
  })

  test("an aborted run leaves interrupted, matching the recovery contract", async () => {
    const { agent, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))

    const started = await session.beginRun(RUN_MODEL)
    await session.finishRun(started.id, {
      aborted: true,
      finishReason: "aborted",
      usage: {},
      modelCalls: 0,
      toolCalls: 0,
    })

    expect(session.status).toBe("interrupted")
    cleanup()
  })

  test("a non-active run identity cannot finalize (AC3)", async () => {
    const { agent, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))

    const a = await session.beginRun(RUN_MODEL)
    await session.finishRun(a.id, {
      aborted: false,
      finishReason: "stop",
      usage: {},
      modelCalls: 0,
      toolCalls: 0,
    })
    const b = await session.beginRun(RUN_MODEL)

    await expect(
      session.finishRun(a.id, { aborted: false, finishReason: "error", usage: {}, modelCalls: 0, toolCalls: 0 }),
    ).rejects.toThrow(/not the active run/)

    // B is untouched: still active, still unfinished.
    expect(session.status).toBe("running")
    expect(session.runs.find(r => r.id === b.id)?.finishedAt).toBeUndefined()
    cleanup()
  })

  test("an unknown run identity cannot finalize (AC3)", async () => {
    const { agent, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))
    await session.beginRun(RUN_MODEL)

    await expect(
      session.finishRun("does-not-exist", { aborted: false, finishReason: "stop", usage: {}, modelCalls: 0, toolCalls: 0 }),
    ).rejects.toThrow(/not the active run/)
    expect(session.status).toBe("running")
    cleanup()
  })

  test("finishing twice cannot overwrite the terminal record (AC4)", async () => {
    const { agent, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))

    const a = await session.beginRun(RUN_MODEL)
    const first = await session.finishRun(a.id, {
      aborted: false,
      finishReason: "stop",
      usage: { inputTokens: 1 },
      modelCalls: 1,
      toolCalls: 0,
    })

    await expect(
      session.finishRun(a.id, {
        aborted: false,
        finishReason: "error",
        usage: { inputTokens: 999 },
        modelCalls: 9,
        toolCalls: 9,
      }),
    ).rejects.toThrow(/not the active run/)

    expect(session.runs.find(r => r.id === a.id)).toEqual(first)
    expect(session.status).toBe("idle")
    cleanup()
  })

  test("a session can begin a new run after an aborted one", async () => {
    const { agent, cleanup } = harness()
    const session = agent.createSession(join(tempDir().dir, "ws"))

    const a = await session.beginRun(RUN_MODEL)
    await session.finishRun(a.id, { aborted: true, finishReason: "aborted", usage: {}, modelCalls: 0, toolCalls: 0 })
    expect(session.status).toBe("interrupted")

    const b = await session.beginRun(RUN_MODEL)
    expect(session.status).toBe("running")
    expect(session.runs).toHaveLength(2)
    expect(session.runs[1]!.id).toBe(b.id)
    cleanup()
  })
})

describe("Session durability (V2, AC6)", () => {
  test("checkpointed sessions survive reload through the store", async () => {
    const { agent, dir, cleanup } = harness(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "write", input: { filePath: "a.txt", content: "hi" } }]),
      textResponse("wrote it"),
    ]))
    const workspace = join(dir, "ws")
    mkdirSync(workspace, { recursive: true })
    const session = agent.createSession(workspace)
    await agent.run(session, "write a file")

    const reloaded = await agent.loadSession(session.id)
    expect(reloaded.messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(reloaded.ledger.get("call_1")?.status).toBe("succeeded")
    expect(readFileSync(join(workspace, "a.txt"), "utf-8")).toBe("hi")
    cleanup()
  })
})

