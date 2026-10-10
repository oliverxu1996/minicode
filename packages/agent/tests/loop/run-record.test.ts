/**
 * What a run durably records: its RunSummary, its per-run tool and model
 * counts, its one authoritative usage total, and the context-management
 * observations it reports. These are the run's "what happened" facts.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ModelError } from "@loongcode/model"
import type { RunEvent } from "../../src/loop/events"
import type { RunSummary } from "../../src/session/types"
import { FakeModel, textResponse, toolCallResponse } from "../support/testing"
import { agentFor } from "../support/loop"
import { LoongCode } from "../../src/loongcode"

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
    const fresh = new LoongCode({ sessionsDir: join(dir, "sessions"), model })
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


describe("token accounting ownership (Work 4)", () => {
  const longTask = `filler ${"filler ".repeat(4000)} and do the thing`

  test("a normal run records usage on the one authoritative holder", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      textResponse("done", { usage: { inputTokens: 300, outputTokens: 12 } }),
    ]))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    await agent.run(session, "hello", { onEvent: e => events.push(e) })

    expect(session.runs[0]!.usage).toEqual({ inputTokens: 300, outputTokens: 12 })
    const end = events.find(e => e.type === "run_end")
    if (end?.type !== "run_end") throw new Error("expected run_end")
    expect(end.run.usage).toEqual({ inputTokens: 300, outputTokens: 12 })
    // No second usage holder rides alongside the record.
    expect("usage" in end).toBe(false)
    cleanup()
  })

  // The adversarial case. The removed holder was the loop's own counter, which
  // never saw a compaction call and therefore reported a smaller total than the
  // record whenever one occurred. Now there is only the record.
  test("a compacted run keeps one usage total, so nothing can diverge", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse(
        [{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }],
        { usage: { inputTokens: 900, outputTokens: 20 } }, // over the proactive threshold
      ),
      textResponse("summary of the conversation", { usage: { inputTokens: 50, outputTokens: 10 } }),
      textResponse("finished after compaction", { usage: { inputTokens: 200, outputTokens: 5 } }),
    ], { contextWindow: 1000, maxOutputTokens: 250 }))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    const result = await agent.run(session, longTask, { onEvent: e => events.push(e) })

    expect(result.finishReason).toBe("stop")
    // Compaction actually happened — this is not a counter-mutation fixture.
    expect(events.filter(e => e.type === "compaction")).toHaveLength(1)

    // 900 + 50 + 200 input, 20 + 10 + 5 output. The removed holder would have
    // reported 1100/30 here, having omitted the summarization call entirely.
    const authoritative = { inputTokens: 1150, outputTokens: 35 }
    expect(session.runs[0]!.usage).toEqual(authoritative)

    const end = events.find(e => e.type === "run_end")
    if (end?.type !== "run_end") throw new Error("expected run_end")
    expect(end.run.usage).toEqual(authoritative)
    expect("usage" in end).toBe(false)
    cleanup()
  })

  test("the persisted stream carries the same usage the record holds", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse(
        [{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }],
        { usage: { inputTokens: 400, outputTokens: 15 } },
      ),
      textResponse("done", { usage: { inputTokens: 100, outputTokens: 9 } }),
    ]))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    await agent.run(session, "count", { onEvent: e => events.push(e) })

    // What a JSONL consumer does with these same events: add up what each call
    // reported. A run's totals must be a projection of that, not a second
    // independently maintained number.
    const summed = events.reduce(
      (acc, e) => {
        const u = e.type === "model_response" || e.type === "compaction" ? e.usage : undefined
        if (u === undefined) return acc
        return {
          inputTokens: acc.inputTokens + (u.inputTokens ?? 0),
          outputTokens: acc.outputTokens + (u.outputTokens ?? 0),
        }
      },
      { inputTokens: 0, outputTokens: 0 },
    )

    expect(session.runs[0]!.usage).toEqual(summed)
    expect(session.runs[0]!.usage).toEqual({ inputTokens: 500, outputTokens: 24 })
    cleanup()
  })
})


describe("context-management observability (O4)", () => {
  /** A task large enough that compaction finds a region to summarize. */
  const longTask = `filler ${"filler ".repeat(4000)} and do the thing`

  test("run usage counts a compaction's own model call exactly once", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse(
        [{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }],
        { usage: { inputTokens: 900, outputTokens: 20 } }, // over the proactive threshold
      ),
      textResponse("summary of the conversation", { usage: { inputTokens: 50, outputTokens: 10 } }),
      textResponse("finished after compaction", { usage: { inputTokens: 200, outputTokens: 5 } }),
    ], { contextWindow: 1000, maxOutputTokens: 250 }))
    const session = agent.createSession(dir)

    const result = await agent.run(session, longTask)

    expect(result.finishReason).toBe("stop")
    // 900 + 50 + 200 input, 20 + 10 + 5 output. Counting the compaction twice
    // would give 1200/40; omitting it would give 1100/30.
    expect(session.runs[0]!.usage).toEqual({ inputTokens: 1150, outputTokens: 35 })
    cleanup()
  })

  test("provider-triggered compaction is observable and carries its usage", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }]),
      { error: new ModelError("context_exceeded", "context_exceeded: request too large") },
      textResponse("summary of the conversation", { usage: { inputTokens: 70, outputTokens: 8 } }),
      textResponse("recovered after compaction retry"),
    ], { contextWindow: 1000, maxOutputTokens: 250 }))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    const result = await agent.run(session, longTask, { onEvent: event => events.push(event) })

    expect(result.finishReason).toBe("stop")
    const compactions = events.filter(event => event.type === "compaction")
    expect(compactions).toHaveLength(1)
    expect(compactions[0]).toMatchObject({
      summarizedMessages: expect.any(Number),
      usage: { inputTokens: 70, outputTokens: 8 },
    })
    // The rejected request is neither a model call nor a source of usage.
    expect(session.runs[0]!.usage).toEqual({ inputTokens: 70, outputTokens: 8 })
    cleanup()
  })

  test("a compaction that cannot make progress emits no completed event", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse(
        [{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }],
        { usage: { inputTokens: 900 } },
      ),
      textResponse(""), // the summarization yields nothing → no progress
    ], { contextWindow: 1000, maxOutputTokens: 250 }))
    const session = agent.createSession(dir)
    const events: RunEvent[] = []

    const result = await agent.run(session, longTask, { onEvent: event => events.push(event) })

    expect(result.finishReason).toBe("error")
    expect(events.filter(event => event.type === "compaction")).toEqual([])
    cleanup()
  })

  test("a run that withheld tool output records what it pruned", async () => {
    const { agent, model, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse([{ toolCallId: "call_1", toolName: "read", input: { filePath: "big.txt" } }]),
      textResponse("done"),
    ], { contextWindow: 1000, maxOutputTokens: 250 }))
    // A result far larger than the 750-token input budget, so the next request
    // cannot fit and pruning has to reduce it.
    writeFileSync(join(dir, "big.txt"), "a line of reasonably long text\n".repeat(600))
    const session = agent.createSession(dir)

    await agent.run(session, "read the file")

    const pruning = session.runs[0]!.pruning
    expect(pruning).toBeDefined()
    expect(pruning!.reduced).toBeGreaterThan(0)
    expect(pruning!.originalBytes).toBeGreaterThan(0)
    cleanup()
  })

  test("compaction usage stays inside the run that incurred it", async () => {
    const { agent, dir, cleanup } = agentFor(new FakeModel([
      toolCallResponse(
        [{ toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } }],
        { usage: { inputTokens: 900, outputTokens: 20 } },
      ),
      textResponse("summary of the conversation", { usage: { inputTokens: 50, outputTokens: 10 } }),
      textResponse("first done", { usage: { inputTokens: 200, outputTokens: 5 } }),
      textResponse("second done", { usage: { inputTokens: 5, outputTokens: 1 } }),
    ], { contextWindow: 1000, maxOutputTokens: 250 }))
    const session = agent.createSession(dir)

    await agent.run(session, longTask)
    await agent.run(session, "a second, unrelated task")

    expect(session.runs[0]!.usage).toEqual({ inputTokens: 1150, outputTokens: 35 })
    // The second run starts from zero: it inherits none of the first run's
    // compaction cost.
    expect(session.runs[1]!.usage).toEqual({ inputTokens: 5, outputTokens: 1 })
    cleanup()
  })
})
