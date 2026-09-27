import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelError } from "@minicode/model"
import type { RunEvent } from "./session/types"
import { FakeModel, textResponse, toolCallResponse } from "./testing"
import { MiniCode } from "./minicode"

function tempWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "minicode-agent-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function agentFor(model: FakeModel): { agent: MiniCode; model: FakeModel; dir: string; cleanup: () => void } {
  const { dir, cleanup } = tempWorkspace()
  const agent = new MiniCode({ sessionsDir: join(dir, "sessions"), model })
  return { agent, model, dir, cleanup }
}

describe("AgentLoop control flow (V2)", () => {
  test("tool call executes, result returns to model, next iteration finishes (AC1/AC5)", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "echo runtime-ok" } }]),
      textResponse("done with the task"),
    ]))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    const result = await agent.run(session, "run echo", { onEvent: e => events.push(e) })

    expect(result.aborted).toBe(false)
    expect(result.finishReason).toBe("stop")
    expect(result.iterations).toBe(2)

    // History shape: user, assistant(call), tool(result), assistant(final).
    expect(session.messages.map(m => m.role)).toEqual(["user", "assistant", "tool", "assistant"])
    const toolMsg = session.messages[2]
    if (toolMsg.role !== "tool") throw new Error("expected tool message")
    expect(toolMsg.content).toEqual([{
      toolCallId: "call_1",
      toolName: "bash",
      output: { type: "text", text: "runtime-ok\n\n(exit code: 0)" },
    }])
    // The second model request must contain the executed tool result.
    const second = model.requests[1]
    const secondTool = second.messages.find(m => m.role === "tool")
    expect(secondTool).toBeDefined()
    expect(events.some(e => e.type === "tool_call" && e.name === "bash")).toBe(true)
    expect(events.some(e => e.type === "tool_result" && e.ok === true)).toBe(true)
    expect(events[events.length - 1]).toMatchObject({ type: "run_end", finishReason: "stop", iterations: 2 })
    cleanup()
  })

  test("steering interrupts the stream and redirects the agent (AC4)", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      {
        content: "partial answer",
        toolCalls: [{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }],
        finishReason: "tool_call",
      },
      textResponse("final after steering"),
    ]))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    session.steer("actually do something else")
    const result = await agent.run(session, "original task", { onEvent: e => events.push(e) })

    expect(result.finishReason).toBe("stop")
    expect(events.some(e => e.type === "steered")).toBe(true)
    const roles = session.messages.map(m => m.role)
    expect(roles).toEqual(["user", "assistant", "user", "assistant"])
    // The partial turn is kept (finishReason aborted)…
    const partial = session.messages[1]
    if (partial.role !== "assistant") throw new Error("expected assistant")
    expect(partial.finishReason).toBe("aborted")
    // …and the steering instruction is the next user message.
    const steerMsg = session.messages[2]
    if (steerMsg.role !== "user") throw new Error("expected user")
    expect(steerMsg.content).toBe("actually do something else")
    cleanup()
  })

  test("text deltas stream to the UI as assistant_delta events (G1)", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      {
        content: "first response",
        toolCalls: [{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }],
        finishReason: "tool_call",
      },
      textResponse("final answer"),
    ]))
    const session = agent.createSession(dir)
    const deltas: string[] = []

    await agent.run(session, "stream it", {
      onEvent: e => {
        if (e.type === "assistant_delta") deltas.push(e.text)
      },
    })

    // One delta per scripted text response, in order.
    expect(deltas).toEqual(["first response", "final answer"])
    cleanup()
  })

  test("tool failure is data: the model continues and repairs (AC4/AC5)", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "read", input: { filePath: "missing.txt" } }]),
      textResponse("recovered after seeing the error"),
    ]))
    const session = agent.createSession(dir)

    const result = await agent.run(session, "read missing file")

    expect(result.finishReason).toBe("stop")
    const toolMsg = session.messages[2]
    if (toolMsg.role !== "tool") throw new Error("expected tool message")
    expect(toolMsg.content[0].output.type).toBe("tool_error")
    if (toolMsg.content[0].output.type === "tool_error") {
      expect(toolMsg.content[0].output.text).toContain("File not found")
    }
    cleanup()
  })

  test("non-zero command exit codes are observable data, not failures (AC4)", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "exit 3" } }]),
      textResponse("saw the exit code"),
    ]))
    const session = agent.createSession(dir)

    await agent.run(session, "run failing command")

    const toolMsg = session.messages[2]
    if (toolMsg.role !== "tool") throw new Error("expected tool message")
    expect(toolMsg.content[0].output).toEqual({ type: "text", text: "\n(exit code: 3)" })
    cleanup()
  })

  test("three identical tool calls trigger doom-loop protection (AC9)", async () => {
    const call = { toolCallId: "call_x", toolName: "bash", input: { command: "echo same" } }
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([call]),
      toolCallResponse([{ ...call, toolCallId: "call_x2" }]),
      toolCallResponse([{ ...call, toolCallId: "call_x3" }]),
      textResponse("never reached"),
    ]))
    const session = agent.createSession(dir)

    const result = await agent.run(session, "loop forever")

    expect(result.finishReason).toBe("doom-loop")
    expect(result.iterations).toBe(3)
    cleanup()
  })

  test("maximum iteration protection terminates the run (AC9)", async () => {
    let n = 0
    const { agent, dir, cleanup } = agentFor(new FakeModel(
      Array.from({ length: 10 }, () =>
        toolCallResponse([{ toolCallId: `call_${++n}`, toolName: "bash", input: { command: `echo ${n}` } }]),
      ),
    ))
    const session = agent.createSession(dir)

    const result = await agent.run(session, "never finish", { maxIterations: 4 })

    expect(result.finishReason).toBe("max-iterations")
    expect(result.iterations).toBe(5) // 4 executed + 1 rejected over the cap
    cleanup()
  })

  test("abort signal terminates the run as aborted (AC9)", async () => {
    const controller = new AbortController()
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }]),
      toolCallResponse([{ toolCallId: "call_2", toolName: "bash", input: { command: "echo hi2" } }]),
    ]))
    const session = agent.createSession(dir)

    const result = await agent.run(session, "abort me", {
      signal: controller.signal,
      onEvent: e => {
        if (e.type === "tool_result") controller.abort()
      },
    })

    expect(result.aborted).toBe(true)
    expect(result.finishReason).toBe("aborted")
    expect(result.iterations).toBe(2)
    expect(session.status).toBe("interrupted")
    cleanup()
  })

  test("usage-based overflow compacts and continues (AC8)", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }], {
        usage: { inputTokens: 900 }, // >= 75% of the 1000-token window
      }),
      textResponse("summary of the conversation"),
      textResponse("finished after compaction"),
    ], { contextWindow: 1000, maxOutputTokens: 250 }))
    const session = agent.createSession(dir)

    const events: RunEvent[] = []
    // The oversized task turn is what compaction has to summarize.
    const result = await agent.run(session, `filler ${"filler ".repeat(4000)} and do the thing`, {
      onEvent: e => events.push(e),
    })

    expect(result.finishReason).toBe("stop")
    expect(events.some(e => e.type === "compaction" && e.summarizedMessages > 0)).toBe(true)
    const summary = session.messages.find(
      m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Compacted conversation summary]"),
    )
    expect(summary).toBeDefined()
    cleanup()
  })

  test("provider-reported context_exceeded compacts once and retries (AC8)", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }]),
      { error: new ModelError("context_exceeded", "context_exceeded: request too large") },
      textResponse("summary of the conversation"),
      textResponse("recovered after compaction retry"),
    ], { contextWindow: 1000, maxOutputTokens: 250 }))
    const session = agent.createSession(dir)

    const result = await agent.run(session, `filler ${"filler ".repeat(4000)} and do the thing`)

    expect(result.finishReason).toBe("stop")
    const summary = session.messages.find(
      m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Compacted conversation summary]"),
    )
    expect(summary).toBeDefined()
    cleanup()
  })

  test("rate-limited calls auto-retry with backoff and then succeed (auto-retry)", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      { error: new ModelError("rate_limited", "rate_limited: provider busy (1305)") },
      { error: new ModelError("rate_limited", "rate_limited: provider busy (1305)") },
      textResponse("recovered after backoff"),
    ]))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    const result = await agent.run(session, "retry me", { onEvent: e => events.push(e), autoRetryDelayMs: 10 })

    expect(result.finishReason).toBe("stop")
    const retries = events.filter(e => e.type === "auto_retry")
    expect(retries).toHaveLength(2)
    expect(retries[0]).toMatchObject({ attempt: 1, maxAttempts: 3 })
    cleanup()
  })

  test("auto-retry gives up after the cap and reports the error (AC9)", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      { error: new ModelError("rate_limited", "still limited 1") },
      { error: new ModelError("rate_limited", "still limited 2") },
      { error: new ModelError("rate_limited", "still limited 3") },
      { error: new ModelError("rate_limited", "still limited 4") },
    ]))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    const result = await agent.run(session, "doomed", {
      onEvent: e => events.push(e),
      autoRetryDelayMs: 10,
    })

    expect(result.finishReason).toBe("error")
    expect(result.error).toContain("still limited 4")
    expect(events.filter(e => e.type === "auto_retry")).toHaveLength(3)
    cleanup()
  })

  test("model errors end the run with finishReason error (AC9)", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      { error: new ModelError("invalid_response", "invalid_response: malformed payload") },
    ]))
    const session = agent.createSession(dir)

    const result = await agent.run(session, "will fail")

    expect(result.finishReason).toBe("error")
    expect(result.error).toContain("invalid_response")
    expect(session.status).toBe("idle")
    cleanup()
  })
})

describe("Session durability (V2, AC6)", () => {
  test("checkpointed sessions survive reload through the store", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
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
