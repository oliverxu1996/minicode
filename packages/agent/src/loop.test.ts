import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelError } from "@minicode/model"
import type { RunEvent, RunSummary } from "./session/types"
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

describe("Run record (O2)", () => {
  test("a completed run records identity, timing, counts and usage", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse(
        [{ toolCallId: "call_1", toolName: "ls", input: { path: "." } }],
        { usage: { inputTokens: 1200, outputTokens: 40 } },
      ),
      textResponse("done", { usage: { inputTokens: 1500, outputTokens: 25 } }),
    ]))
    const session = agent.createSession(dir)

    await agent.run(session, "list the files")

    expect(session.runs).toHaveLength(1)
    const run = session.runs[0]!
    // The session id identifies the session, not the run: one session executes
    // many tasks, and `--continue` deliberately reuses it.
    expect(run.id).toEqual(expect.any(String))
    expect(run.id).not.toBe(session.id)
    expect(run.startedAt).toEqual(expect.any(Number))
    expect(run.finishedAt!).toBeGreaterThanOrEqual(run.startedAt)
    expect(run.finishReason).toBe("stop")
    expect(run.model).toEqual({
      id: "fake-model",
      name: "Fake Model",
      protocol: "openai",
      model: "fake-model",
      contextWindow: 128000,
      maxOutputTokens: 32000,
    })
    // Summed over the run's two model calls.
    expect(run.usage).toEqual({ inputTokens: 2700, outputTokens: 65 })
    expect(run.modelCalls).toBe(2)
    expect(run.toolCalls).toBe(1)
    expect(run.error).toBeUndefined()
    cleanup()
  })

  test("run events carry the run id and the completed record", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([textResponse("done")]))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    await agent.run(session, "do the task", { onEvent: event => events.push(event) })

    const run = session.runs[0]!
    const start = events.find(event => event.type === "run_start")
    const end = events.find(event => event.type === "run_end")
    if (start?.type !== "run_start" || end?.type !== "run_end") {
      throw new Error("expected run boundary events")
    }

    // One id joins the events, the returned record, and the snapshot.
    expect(start.runId).toBe(run.id)
    expect(start.sessionId).toBe(session.id)
    expect(start.model).toEqual(run.model)
    expect(end.runId).toBe(run.id)
    expect(end.run).toEqual(run)
    cleanup()
  })

  test("a run that has not finished records no terminal facts", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([textResponse("done")]))
    const session = agent.createSession(dir)

    // Read the snapshot the moment the run starts: exactly the state a crash
    // mid-run leaves on disk.
    let onDisk: { runs?: RunSummary[] } | undefined
    await agent.run(session, "do the task", {
      onEvent: event => {
        if (event.type !== "run_start" || onDisk !== undefined) return
        onDisk = JSON.parse(readFileSync(join(dir, "sessions", `${session.id}.json`), "utf-8"))
      },
    })

    const partial = onDisk?.runs?.[0]
    if (partial === undefined) throw new Error("expected a run record on disk")
    expect(partial.startedAt).toEqual(expect.any(Number))
    expect(partial.model.id).toBe("fake-model")
    // Nothing is fabricated for a run that never reached a terminal state.
    expect(partial).not.toHaveProperty("finishedAt")
    expect(partial).not.toHaveProperty("finishReason")
    expect(partial).not.toHaveProperty("usage")
    expect(partial).not.toHaveProperty("modelCalls")
    expect(partial).not.toHaveProperty("toolCalls")
    cleanup()
  })

  test("runs in one session stay separately identifiable, and survive reload", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      textResponse("first", { usage: { inputTokens: 100, outputTokens: 10 } }),
      textResponse("second", { usage: { inputTokens: 200, outputTokens: 20 } }),
    ]))
    const session = agent.createSession(dir)

    await agent.run(session, "first task")
    await agent.run(session, "second task")

    expect(session.runs).toHaveLength(2)
    const first = session.runs[0]!
    const second = session.runs[1]!
    expect(first.id).not.toBe(second.id)
    expect(first.finishedAt!).toBeLessThanOrEqual(second.startedAt)
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 10 })
    expect(second.usage).toEqual({ inputTokens: 200, outputTokens: 20 })

    // Through a fresh runtime root, as a restarted process would read it.
    const fresh = new MiniCode({ sessionsDir: join(dir, "sessions"), model })
    const reloaded = await fresh.loadSession(session.id)
    expect(reloaded.runs).toEqual(session.runs)
    cleanup()
  })
})

describe("Tool duration and per-run counts (O3)", () => {
  test("a tool_result reports the interval the ledger recorded", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "ls", input: { path: "." } }]),
      textResponse("done"),
    ]))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    await agent.run(session, "list the files", { onEvent: event => events.push(event) })

    const result = events.find(event => event.type === "tool_result")
    if (result?.type !== "tool_result") throw new Error("expected a tool_result")

    // The event agrees with the durable pair it was derived from.
    const entry = session.ledger.get("call_1")!
    expect(result.durationMs).toBe(entry.finishedAt! - entry.startedAt!)
    expect(typeof result.durationMs).toBe("number")
    cleanup()
  })

  test("a run counts exactly the tool results it produced", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      // Three distinct calls in one assistant turn: three tool results across
      // two iterations, so the count cannot be the iteration count.
      toolCallResponse([
        { toolCallId: "call_1", toolName: "ls", input: { path: "." } },
        { toolCallId: "call_2", toolName: "bash", input: { command: "echo a" } },
        { toolCallId: "call_3", toolName: "bash", input: { command: "echo b" } },
      ]),
      textResponse("done"),
    ]))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    const result = await agent.run(session, "look around", { onEvent: event => events.push(event) })

    expect(events.filter(event => event.type === "tool_result")).toHaveLength(3)
    expect(result.iterations).toBe(2)
    expect(session.runs[0]!.toolCalls).toBe(3)
    cleanup()
  })

  test("tool counts are scoped to the run, not the session", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "ls", input: { path: "." } }]),
      textResponse("first"),
      toolCallResponse([
        { toolCallId: "call_2", toolName: "bash", input: { command: "echo a" } },
        { toolCallId: "call_3", toolName: "bash", input: { command: "echo b" } },
      ]),
      textResponse("second"),
    ]))
    const session = agent.createSession(dir)

    await agent.run(session, "first task")
    await agent.run(session, "second task")

    // The ledger is session-scoped and holds every invocation…
    expect(session.ledger.all).toHaveLength(3)
    // …while each run counts only its own.
    expect(session.runs[0]!.toolCalls).toBe(1)
    expect(session.runs[1]!.toolCalls).toBe(2)
    cleanup()
  })

  test("observability does not change what a failing command means", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "exit 1" } }]),
      textResponse("I could not fix it"),
    ]))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    const result = await agent.run(session, "run the failing command", {
      onEvent: event => events.push(event),
    })

    const toolResult = events.find(event => event.type === "tool_result")
    if (toolResult?.type !== "tool_result") throw new Error("expected a tool_result")

    // A non-zero exit stays `ok` — exit codes are data — and remains evidence.
    expect(toolResult.ok).toBe(true)
    expect(session.ledger.get("call_1")?.status).toBe("succeeded")
    expect(session.messages.find(m => m.role === "tool")?.failureEvidence).toBe(true)
    // The run still ends on the model's terms, not the command's exit code.
    expect(result.finishReason).toBe("stop")
    // The new observability rides alongside without altering any of it.
    expect(typeof toolResult.durationMs).toBe("number")
    cleanup()
  })
})
