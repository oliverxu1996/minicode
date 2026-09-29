import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Model } from "@minicode/model"
import { MiniCode } from "./minicode"
import { Session, UNKNOWN_OUTCOME_ERROR } from "./session/session"
import { SessionStore } from "./session/store"
import { ToolLedger } from "./session/ledger"
import { CODING_TOOLS } from "./tools"
import { executeTool } from "./loop/run"
import { FakeModel, textResponse } from "./testing"

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

    session.status = "running" // crash mid-run: persisted before execution
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

    session.status = "running" // crash mid-run: persisted before execution
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

    session.status = "running" // crash mid-run: persisted before execution
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
    session.status = "running" // crash mid-run: persisted before execution
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

    // The provider-reported breakdown, as the model layer carries it.
    session.appendAssistant(
      [{ type: "text", text: "done" }],
      {
        usage: {
          inputTokens: 1050,
          outputTokens: 20,
          totalTokens: 1070,
          cacheReadTokens: 900,
          cacheWriteTokens: 50,
          reasoningTokens: 7,
        },
        finishReason: "stop",
      },
    )

    // Through a fresh runtime root, as a restarted process would read it.
    const persisted = await reloadAsNewProcess(session)
    const assistant = persisted.messages.find(message => message.role === "assistant")
    if (assistant?.role !== "assistant") throw new Error("expected an assistant message")

    expect(assistant.usage).toEqual({
      inputTokens: 1050,
      outputTokens: 20,
      totalTokens: 1070,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
      reasoningTokens: 7,
    })
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
