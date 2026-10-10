/**
 * AgentLoop — the iteration engine: model streaming, steering, tool
 * execution, guards, abort, and the compaction triggers it drives.
 */
import { describe, expect, test } from "bun:test"
import { basename, join } from "node:path"
import { ModelError } from "@loongcode/model"
import type { RunEvent } from "../../src/loop/events"
import { FakeModel, textResponse, toolCallResponse } from "../support/testing"
import { agentFor } from "../support/loop"

describe("AgentLoop control flow (V2)", () => {
  test("agent-local affordances never reach the provider request", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{
        toolCallId: "call_1",
        toolName: "bash",
        input: { command: "i=0; while [ $i -lt 20000 ]; do echo line-$i; i=$((i+1)); done" },
      }]),
      textResponse("done"),
    ]))
    const session = agent.createSession(dir)

    await agent.run(session, "big output", {})

    // Large enough that the canonical cap externalized it…
    const toolMsg = session.messages[2]
    if (toolMsg.role !== "tool") throw new Error("expected tool message")
    expect(toolMsg.affordances?.call_1?.externalizedAt).toBeDefined()

    // …but recovery metadata is durable agent state, not model-facing content.
    for (const request of model.requests) {
      for (const message of request.messages) {
        expect("affordances" in message).toBe(false)
        expect("failureEvidence" in message).toBe(false)
      }
    }
    const wire = JSON.stringify(model.requests)
    expect(wire).not.toContain("externalizedAt")
    cleanup()
  })

  test("bash defaults to the session workspace without rewriting the recorded call", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "pwd" } }]),
      textResponse("done"),
    ]))
    const session = agent.createSession(dir)

    await agent.run(session, "where am i", {})

    // The runtime default still applies: bash ran in the session workspace.
    const toolMsg = session.messages[2]
    if (toolMsg.role !== "tool") throw new Error("expected tool message")
    const part = toolMsg.content[0] as unknown as { output: { type: string; text: string } }
    expect(part.output.text).toContain(basename(dir))

    // …but the call the model actually made is what durable history keeps. The
    // workspace default is resolved into a local execution input rather than
    // written back into the object the assistant message holds by reference, so
    // the recorded request is not edited by the executor.
    const assistantMsg = session.messages[1]
    if (assistantMsg.role !== "assistant") throw new Error("expected assistant message")
    const call = assistantMsg.content[0] as unknown as { input: Record<string, unknown> }
    expect(call.input).toEqual({ command: "pwd" })
    expect("workdir" in call.input).toBe(false)
    cleanup()
  })

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

  test("long-running bash output streams as tool_progress events", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "printf 'a\\n'; sleep 0.3; printf 'b\\n'" } }]),
      textResponse("saw the output"),
    ]))
    const session = agent.createSession(dir)
    const progress: string[] = []

    await agent.run(session, "stream output", {
      onEvent: e => {
        if (e.type === "tool_progress") progress.push(e.text)
      },
    })

    expect(progress.length).toBeGreaterThan(0)
    const combined = progress.join("")
    expect(combined).toContain("a")
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

  // I6/D5 — compaction must not build a request that overflows for the same
  // reason that triggered it. The evidence is the *actual* recorded request
  // size, not the presence of an error code.
  test("the compaction request itself is bounded (I6)", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      // [0] succeeds, so the turn has an assistant/tool tail that compaction can
      // act on. [1] is the provider rejecting the oversized follow-up request.
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }]),
      { error: new ModelError("context_exceeded", "context_exceeded: request too large") },
      // [2] is the summarization request, [3] the retried main request.
      textResponse("summary of prior work"),
      textResponse("finished after compaction"),
    ], { contextWindow: 1000, maxOutputTokens: 250 }))
    const session = agent.createSession(dir)
    // Enough durable history that compaction has a substantial region to summarize.
    for (let i = 0; i < 120; i++) session.pushUser(`turn ${i} ${"x".repeat(100)}`)

    const result = await agent.run(session, "final task")

    expect(result.finishReason).toBe("stop")
    const inputBudget = Math.floor(1000 * 0.75)
    // [1] is the oversized main request — the reason compaction was needed.
    expect(model.requestSizes[1]).toBeGreaterThan(inputBudget)
    // [2] is the summarization request: bounded, despite 120 turns of history.
    expect(model.requestSizes[2]).toBeLessThanOrEqual(inputBudget)
    // ...and it carries explicit output headroom rather than the provider default.
    expect(model.requests[2].maxOutputTokens).toBe(250)
    cleanup()
  })

  // I7 — an overflow that cannot be compacted must terminate, not retry forever.
  test("context overflow that cannot make progress terminates (I7)", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }], {
        usage: { inputTokens: 900 },
      }),
      textResponse(""), // the summarization yields nothing → no progress possible
    ], { contextWindow: 1000, maxOutputTokens: 250 }))
    const session = agent.createSession(dir)
    for (let i = 0; i < 120; i++) session.pushUser(`turn ${i} ${"x".repeat(100)}`)

    const result = await agent.run(session, "final task")

    expect(result.finishReason).toBe("error")
    expect(result.error).toContain("no progress")
    // Terminal and finite: the main request plus exactly one summarization
    // attempt — no unbounded compact/retry loop.
    expect(model.requests.length).toBe(2)
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

