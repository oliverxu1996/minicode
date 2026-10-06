/**
 * Durable session-state ownership boundaries (F1/F2/F3).
 *
 * F1 — `ToolLedger.all` / `get()` expose read-only views of read-only entries.
 * F2 — `Session.messages` exposes a read-only view; message fields are
 *      read-only.
 * F3 — `Session.replaceMessages()` validates its input and rejects anything the
 *      durable Session format cannot represent faithfully, before mutating.
 *
 * The F1/F2 guarantees are type-level: `@ts-expect-error` lines below must
 * FAIL to compile, which `bun run typecheck` enforces. The closures holding
 * them are never invoked, so no runtime mutation occurs in the suite.
 */
import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "@minicode/model"
import { Compactor } from "./loop/compact"
import { ToolLedger, toolDurationMs } from "./session/ledger"
import { Session } from "./session/session"
import type { SessionMessage } from "./session/types"
import { FakeModel, textResponse } from "./testing"

/** Never invoked: its body exists only so `tsc` checks the read-only boundary. */
function typeOnly(fn: () => void): void {
  void fn
}

function sess(): Session {
  const session = Session.create({ cwd: "/tmp/minicode-boundary-test" })
  session.onCheckpoint(async () => {})
  return session
}

const asHistory = (value: unknown[]): ModelMessage[] => value as ModelMessage[]

/** Establishes `initial`, then proves `invalid` is rejected with no mutation
 *  and no checkpoint. */
async function rejectedWithoutMutation(initial: ModelMessage[], invalid: ModelMessage[]): Promise<void> {
  const session = sess()
  let checkpoints = 0
  session.onCheckpoint(async () => {
    checkpoints += 1
  })
  await session.replaceMessages(initial)
  const before = session.messages.map(m => JSON.stringify({ role: m.role, content: m.content }))
  checkpoints = 0

  await expect(session.replaceMessages(invalid)).rejects.toThrow()

  const after = session.messages.map(m => JSON.stringify({ role: m.role, content: m.content }))
  expect(after).toEqual(before)
  expect(checkpoints).toBe(0)
}

// ---------------------------------------------------------------------------
// F1 — ToolLedger
// ---------------------------------------------------------------------------

describe("F1 — ToolLedger external read boundary", () => {
  test("the collection and its entries are read-only through the public API", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: { command: "x" } })

    typeOnly(() => {
      // @ts-expect-error the collection is a read-only view
      ledger.all.push({ toolCallId: "c2", name: "bash", input: {}, status: "pending" })
      // @ts-expect-error length is read-only
      ledger.all.length = 0
      // @ts-expect-error indexes are read-only
      ledger.all[0] = ledger.all[0]
      // @ts-expect-error collection is a getter-only view
      ledger.all = []
      // @ts-expect-error entry status is read-only
      ledger.get("c1")!.status = "succeeded"
      // @ts-expect-error entry timestamps are read-only
      ledger.get("c1")!.startedAt = 1
      // @ts-expect-error entry note is read-only
      ledger.get("c1")!.note = "x"
      // @ts-expect-error nested input is read-only
      ledger.get("c1")!.input["command"] = "y"
    })

    // The failures above must not have run: state is exactly as created.
    expect(ledger.all).toHaveLength(1)
    expect(ledger.get("c1")?.status).toBe("pending")
    expect(ledger.get("c1")?.input).toEqual({ command: "x" })
  })

  test("legitimate transition methods and serialization still work", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: { command: "x" } })
    ledger.running("c1", { startedAt: 1_000 })
    ledger.finished("c1", "succeeded", { finishedAt: 1_450 })

    expect(toolDurationMs(ledger.get("c1")!)).toBe(450)

    const reloaded = ToolLedger.fromJSON(ledger.toJSON())
    expect(reloaded.get("c1")?.status).toBe("succeeded")
    expect(reloaded.get("c1")?.startedAt).toBe(1_000)
    expect(reloaded.get("c1")?.finishedAt).toBe(1_450)
  })

  test("fromJSON copies nested input rather than sharing it", () => {
    const ledger = ToolLedger.fromJSON([
      { toolCallId: "c1", name: "bash", input: { command: "x" }, status: "pending" },
    ])
    // Mutating the source object after loading must not reach the ledger.
    const reloaded = ToolLedger.fromJSON(ledger.toJSON())
    expect(reloaded.get("c1")?.input).toEqual({ command: "x" })
    expect(reloaded.get("c1")?.input).not.toBe(ledger.get("c1")?.input)
  })

  test("replaceAll does not alias the source ledger's internal collection", () => {
    const session = sess()
    const alias = new ToolLedger()
    session.ledger.replaceAll(alias)

    // The caller still holds `alias`; mutating it must not reach the session.
    alias.pending({ toolCallId: "evil", name: "bash", input: {} })
    expect(session.ledger.get("evil")).toBeUndefined()
    expect(session.ledger.all).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// F2 — Session.messages
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// F3 — replaceMessages validity
// ---------------------------------------------------------------------------

describe("F3 — replaceMessages validation", () => {
  test("accepts normal user/assistant/tool history", async () => {
    const session = sess()
    await session.replaceMessages([
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "x" } },
        ],
      },
      { role: "tool", content: [{ toolCallId: "c1", toolName: "bash", output: { type: "text", text: "ok" } }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ])
    expect(session.messages).toHaveLength(4)
  })

  test("accepts a dangling tool call with no result (D5)", async () => {
    const session = sess()
    await session.replaceMessages([
      { role: "user", content: "task" },
      { role: "assistant", content: [{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: {} }] },
    ])
    expect(session.needsRecovery()).toBe(false)
  })

  test("accepts a plain-string assistant transcript (existing /import shape)", async () => {
    const session = sess()
    await session.replaceMessages(asHistory([
      { role: "user", content: "imported one" },
      { role: "assistant", content: "imported two" },
    ]))
    expect(session.messages).toHaveLength(2)
  })

  test("accepts the history current compaction produces", async () => {
    const session = sess()
    session.pushUser("x".repeat(12_000))
    session.pushUser("y".repeat(4_000))
    session.appendAssistant([{ type: "text", text: "working" }], {})

    const outcome = await new Compactor(new FakeModel([textResponse("summary")]), 1000).compact(session)

    expect(outcome.status).toBe("compacted")
    const first = session.messages[0]
    expect(typeof first.content === "string" ? first.content : "").toContain("[Compacted conversation summary]")
  })

  test("accepts fork/clone/import-equivalent mappings", async () => {
    const source = sess()
    source.pushUser("one")
    source.appendAssistant([{ type: "text", text: "two" }], {})
    source.pushUser("three")

    const clone = sess()
    await clone.replaceMessages(asHistory(source.messages.map(m => ({ role: m.role, content: m.content }))))
    expect(clone.messages).toHaveLength(3)

    const fork = sess()
    await fork.replaceMessages(asHistory(source.messages.slice(0, 1).map(m => ({ role: m.role, content: m.content }))))
    expect(fork.messages).toHaveLength(1)

    const imported = sess()
    await imported.replaceMessages(asHistory([{ role: "user", content: "a" }]))
    expect(imported.messages).toHaveLength(1)
  })

  test("rejects an unsupported durable role before mutating", async () => {
    await rejectedWithoutMutation(
      [{ role: "user", content: "ok" }],
      [{ role: "user", content: "ok" }, { role: "system", content: "sys" }],
    )
  })

  test("rejects malformed message shapes before mutating", async () => {
    const initial: ModelMessage[] = [{ role: "user", content: "ok" }]
    await rejectedWithoutMutation(initial, asHistory([null]))
    await rejectedWithoutMutation(initial, asHistory([{ role: "user", content: 42 }]))
    await rejectedWithoutMutation(initial, asHistory([{ role: "assistant", content: 42 }]))
    await rejectedWithoutMutation(initial, asHistory([{ role: "tool", content: "nope" }]))
    await rejectedWithoutMutation(initial, asHistory([{ role: "assistant", content: [{ type: "mystery" }] }]))
    await rejectedWithoutMutation(initial, asHistory([{ role: "assistant", content: [{ type: "text" }] }]))
    await rejectedWithoutMutation(
      initial,
      asHistory([{ role: "tool", content: [{ toolCallId: "c1", toolName: "bash", output: { type: "unknown" } }] }]),
    )
  })

  test("rejects malformed tool-call/result identity before mutating", async () => {
    const initial: ModelMessage[] = [{ role: "user", content: "ok" }]
    await rejectedWithoutMutation(
      initial,
      asHistory([{ role: "assistant", content: [{ type: "tool_call", toolCallId: "", toolName: "bash", input: {} }] }]),
    )
    await rejectedWithoutMutation(
      initial,
      asHistory([{ role: "tool", content: [{ toolCallId: "", toolName: "bash", output: { type: "text", text: "x" } }] }]),
    )
  })

  test("rejects duplicate tool results for one toolCallId (D3)", async () => {
    await rejectedWithoutMutation(
      [{ role: "user", content: "ok" }],
      asHistory([
        { role: "tool", content: [{ toolCallId: "dup", toolName: "bash", output: { type: "text", text: "a" } }] },
        { role: "tool", content: [{ toolCallId: "dup", toolName: "bash", output: { type: "text", text: "b" } }] },
      ]),
    )
  })

  test("an accepted replacement round-trips semantically through persistence", async () => {
    const session = sess()
    await session.replaceMessages([
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "x" } },
        ],
      },
      { role: "tool", content: [{ toolCallId: "c1", toolName: "bash", output: { type: "json", value: { ok: true } } }] },
    ])

    const reloaded = Session.fromJSON(session.toJSON())
    const semantic = (messages: readonly SessionMessage[]) =>
      messages.map(m => ({ role: m.role, content: m.content }))
    expect(semantic(reloaded.messages)).toEqual(semantic(session.messages))
  })
})
