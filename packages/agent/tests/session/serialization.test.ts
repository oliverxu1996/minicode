/**
 * The durable-format boundary: what may become session history, and how a
 * persisted snapshot is read back.
 *
 * `replaceMessages` accepts `ModelMessage[]`, so anything it takes must be
 * something the loader (`parseMessages`) would interpret identically. These
 * tests pin the accepted/rejected shapes, the pre-mutation atomicity, and the
 * lenient-loading behaviour (malformed persisted entries are dropped, not
 * fatal).
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelMessage } from "@loongcode/model"
import { Compactor } from "../../src/context/compaction"
import { LoongCode } from "../../src/loongcode"
import { Session } from "../../src/session/session"
import type { SessionMessage } from "../../src/session/types"
import { FakeModel, textResponse } from "../support/testing"

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loongcode-serialization-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function sess(): Session {
  const session = Session.create({ cwd: "/tmp/loongcode-boundary-test" })
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

describe("session summaries use the validating parser", () => {
  function summaryHarness() {
    const { dir, cleanup } = tempDir()
    const sessionsDir = join(dir, "sessions")
    return {
      sessionsDir,
      agent: new LoongCode({ sessionsDir }),
      fresh: () => new LoongCode({ sessionsDir }),
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
