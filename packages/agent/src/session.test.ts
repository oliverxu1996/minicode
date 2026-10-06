import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Model } from "@minicode/model"
import type { ModelIdentity } from "./session/types"
import { MiniCode } from "./minicode"
import { Session, UNKNOWN_OUTCOME_ERROR } from "./session/session"
import { SessionStore } from "./session/store"
import { ToolLedger, toolDurationMs } from "./session/ledger"
import { CODING_TOOLS } from "./tools"
import { executeTool } from "./loop/execute"
import { FakeModel, textResponse } from "./testing"

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
  agent: MiniCode
  /** Simulates a crash-restart: persists the live session (the crash-time
   *  snapshot), then loads it through a fresh runtime root with an empty
   *  session cache. */
  reloadAsNewProcess(session: Session): Promise<Session>
  cleanup: () => void
}

function harness(model?: Model): Harness {
  const { dir, cleanup } = tempDir()
  const sessionsDir = join(dir, "sessions")
  const agent = new MiniCode({ sessionsDir, model })
  return {
    agent,
    reloadAsNewProcess: async (session: Session) => {
      await session.checkpoint()
      const fresh = new MiniCode({ sessionsDir, model })
      return fresh.loadSession(session.id)
    },
    cleanup,
  }
}

describe("ToolLedger (AC7)", () => {
  test("transitions pending → running → succeeded", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: { command: "x" } })
    expect(ledger.get("c1")?.status).toBe("pending")
    ledger.running("c1")
    expect(ledger.get("c1")?.status).toBe("running")
    ledger.finished("c1", "succeeded")
    expect(ledger.get("c1")?.status).toBe("succeeded")
  })

  test("illegal transitions throw", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} })
    // Finalizing from `pending` is legal (gate outcomes)…
    ledger.finished("c1", "succeeded")
    // …but a terminal state is immutable.
    expect(() => ledger.running("c1")).toThrow()
    expect(() => ledger.finished("c1", "failed")).toThrow()
    expect(() => ledger.reissue("c1")).toThrow()
  })

  test("duplicate terminal ids error; duplicate pending ids are reissue no-ops", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} })
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} }) // reissue no-op
    expect(ledger.get("c1")?.status).toBe("pending")
    ledger.finished("c1", "failed")
    expect(() => ledger.pending({ toolCallId: "c1", name: "edit", input: {} })).toThrow()
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

describe("session summaries use the validating parser", () => {
  function summaryHarness() {
    const { dir, cleanup } = tempDir()
    const sessionsDir = join(dir, "sessions")
    return {
      sessionsDir,
      agent: new MiniCode({ sessionsDir }),
      fresh: () => new MiniCode({ sessionsDir }),
      cleanup,
    }
  }

  test("a valid session summary agrees with loading that session", async () => {
    const h = summaryHarness()
    const session = h.agent.createSession("/tmp/summary-ws")
    session.pushUser("hello there")
    session.appendAssistant([{ type: "text", text: "hi" }], {})
    session.title = "my session"
    await session.checkpoint()

    const [summary] = await h.fresh().sessionSummaries()
    expect(summary).toBeDefined()
    expect(summary!.id).toBe(session.id)
    expect(summary!.title).toBe("my session")
    expect(summary!.firstUser).toBe("hello there")
    // The picker and the loaded session cannot disagree about size.
    const loaded = await h.fresh().loadSession(session.id)
    expect(summary!.messageCount).toBe(loaded.messages.length)
    h.cleanup()
  })

  // The old summary path cast `json.messages` unchecked and took `.length`. On
  // a corrupt snapshot that is not merely lenient, it is nonsense — a string
  // field yields its character count. The validating parser is what loading
  // already used, so the picker now reports what a load would produce.
  test("a corrupted messages field is validated, not counted raw", async () => {
    const h = summaryHarness()
    const session = h.agent.createSession("/tmp/summary-ws")
    session.pushUser("real message")
    await session.checkpoint()

    const file = join(h.sessionsDir, `${session.id}.json`)
    const json = JSON.parse(readFileSync(file, "utf-8"))
    json.messages = "not-an-array"
    writeFileSync(file, JSON.stringify(json))

    const [summary] = await h.fresh().sessionSummaries()
    expect(summary).toBeDefined()
    expect(summary!.messageCount).toBe(0)
    h.cleanup()
  })

  test("invalid entries are dropped rather than counted", async () => {
    const h = summaryHarness()
    const session = h.agent.createSession("/tmp/summary-ws")
    session.pushUser("real message")
    await session.checkpoint()

    const file = join(h.sessionsDir, `${session.id}.json`)
    const json = JSON.parse(readFileSync(file, "utf-8"))
    json.messages = [
      { role: "user", content: "kept", timestamp: 1 },
      { role: "bogus", content: "dropped" },
      "garbage",
    ]
    writeFileSync(file, JSON.stringify(json))

    const [summary] = await h.fresh().sessionSummaries()
    expect(summary!.messageCount).toBe(1)
    expect(summary!.firstUser).toBe("kept")
    h.cleanup()
  })

  test("normal session loading is unaffected", async () => {
    const h = summaryHarness()
    const session = h.agent.createSession("/tmp/summary-ws")
    session.pushUser("round trip")
    await session.checkpoint()

    const loaded = await h.fresh().loadSession(session.id)
    expect(loaded.messages).toHaveLength(1)
    expect((loaded.messages[0] as { content: string }).content).toBe("round trip")
    h.cleanup()
  })
})

describe("Tool duration (O3)", () => {
  // Derived from the ledger's own timestamps, which stay the durable source.
  // A duration the runtime has no evidence for must stay unknown — never 0.

  test("a completed invocation reports the interval it actually spanned", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} })
    ledger.running("c1", { startedAt: 1_000 })
    ledger.finished("c1", "succeeded", { finishedAt: 1_450 })

    expect(toolDurationMs(ledger.get("c1")!)).toBe(450)
  })

  test("an invocation that never started reports no duration", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} })
    ledger.finished("c1", "failed", { finishedAt: 1_450 })

    expect(ledger.get("c1")!.startedAt).toBeUndefined()
    expect(toolDurationMs(ledger.get("c1")!)).toBeUndefined()
  })

  test("an invocation that never finished reports no duration", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} })
    ledger.running("c1", { startedAt: 1_000 })

    expect(toolDurationMs(ledger.get("c1")!)).toBeUndefined()
  })

  test("a reissued invocation is not measured across the gap", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "read", input: {} })
    ledger.running("c1", { startedAt: 1_000 })
    ledger.reissue("c1", "previous outcome unknown; idempotent tool reissued after restart")

    // Reissue erases the interval: nothing pairs the stale start with a later
    // end, so the gap is not reported as execution time.
    expect(toolDurationMs(ledger.get("c1")!)).toBeUndefined()

    // The re-execution reports its own interval, not the one spanning the gap.
    ledger.running("c1", { startedAt: 5_000 })
    ledger.finished("c1", "succeeded", { finishedAt: 5_450 })
    expect(toolDurationMs(ledger.get("c1")!)).toBe(450)
  })

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

describe("Run record migration (O2)", () => {
  test("a snapshot written before run records existed still loads", () => {
    // Sessions persisted by an earlier version have no `runs` key at all; one
    // must load as a session with no recorded runs, not fail.
    const session = Session.fromJSON({
      version: 1,
      id: "s1",
      cwd: "/tmp",
      status: "idle",
      messages: [],
    })
    expect(session.runs).toEqual([])
  })

  test("a malformed run record is skipped rather than failing the load", () => {
    const session = Session.fromJSON({
      version: 1,
      id: "s1",
      cwd: "/tmp",
      status: "idle",
      messages: [],
      runs: [
        { id: "run-1", startedAt: 1, model: { id: "m" } },
        { startedAt: 2, model: { id: "m" } }, // no id
        "not a record",
      ],
    })
    expect(session.runs).toHaveLength(1)
    expect(session.runs[0]!.id).toBe("run-1")
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

describe("Model resolution (V2)", () => {
  test("MiniCode without a configured model reports the missing dependency", async () => {
    const { dir, cleanup } = tempDir()
    const previousConfigDir = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(dir, "config")
    try {
      const agent = new MiniCode()
      const session = agent.createSession(join(dir, "ws"))
      await expect(agent.run(session, "no model")).rejects.toThrow(/No active model/)
    } finally {
      if (previousConfigDir === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousConfigDir
    }
    cleanup()
  })
})
