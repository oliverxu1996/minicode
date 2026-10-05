/**
 * Work 3 — Session checkpoint ownership.
 *
 * The invariant under test throughout: after a successful lifecycle mutation
 * returns, the resulting session is ALREADY durable. Every test therefore
 * discards the in-memory object and reloads from disk through a fresh runtime,
 * because that is the only way to tell "durable" from "still in memory".
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Compactor } from "./loop/compact"
import { runTask } from "./loop/run"
import { MiniCode } from "./minicode"
import { Session } from "./session/session"
import { FakeModel, textResponse, toolCallResponse } from "./testing"
import { findCommand, type CommandContext } from "./tui/commands"
import type { Tool } from "./tools"

interface Fixture {
  readonly dir: string
  readonly sessionsDir: string
  readonly agent: MiniCode
  /** A second runtime over the same store — "the process restarted". */
  reload(id: string): Promise<Session>
  cleanup(): void
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "minicode-lifecycle-"))
  const sessionsDir = join(dir, "sessions")
  const agent = new MiniCode({ sessionsDir, model: new FakeModel([textResponse("ok")]) })
  return {
    dir,
    sessionsDir,
    agent,
    reload: async (id: string): Promise<Session> =>
      await new MiniCode({ sessionsDir }).loadSession(id),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** A command context over a real runtime, so persistence is real too. */
function context(agent: MiniCode, session: Session, picked: string | null = null) {
  let active = session
  const notices: string[] = []
  const ctx = {
    agent: () => agent,
    session: () => active,
    setSession: (next: Session) => { active = next },
    notify: (text: string) => { notices.push(text) },
    pick: async () => picked,
    ask: async () => null,
    compact: async () => ({ status: "no-model" }) as const,
    submitTask: async () => {},
    skills: () => [],
    reloadResources: () => {},
  } as unknown as CommandContext
  return { ctx, notices, current: (): Session => active }
}

async function seed(session: Session): Promise<void> {
  session.pushUser("first task")
  session.appendAssistant([{ type: "text", text: "first answer" }], {})
  session.pushUser("second task")
}

describe("session lifecycle durability (Work 3)", () => {
  test("AC1 — /fork is durable when the command returns", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    await seed(session)

    const { ctx, current } = context(f.agent, session, "0")
    await findCommand("fork")!.execute(ctx, "")
    const forked = current()
    expect(forked.id).not.toBe(session.id)

    // Reload through a fresh runtime: nothing else may be required.
    const reloaded = await f.reload(forked.id)
    expect(reloaded.id).toBe(forked.id)
    expect(reloaded.parentSessionId).toBe(session.id)
    expect(reloaded.messages).toHaveLength(1)
    expect((reloaded.messages[0] as { content: string }).content).toBe("first task")
    f.cleanup()
  })

  test("AC2 — /clone is durable when the command returns", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    await seed(session)

    const { ctx, current } = context(f.agent, session)
    await findCommand("clone")!.execute(ctx, "")
    const clone = current()
    expect(clone.id).not.toBe(session.id)

    const reloaded = await f.reload(clone.id)
    expect(reloaded.parentSessionId).toBe(session.id)
    expect(reloaded.messages.map(m => m.role)).toEqual(["user", "assistant", "user"])
    expect((reloaded.messages[0] as { content: string }).content).toBe("first task")
    f.cleanup()
  })

  test("AC3 — /import is durable when the command returns", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    const jsonl = join(f.dir, "import.jsonl")
    writeFileSync(jsonl, [
      JSON.stringify({ role: "user", content: "imported one" }),
      JSON.stringify({ role: "assistant", content: "imported two" }),
    ].join("\n"))

    const { ctx, current } = context(f.agent, session)
    await findCommand("import")!.execute(ctx, jsonl)
    const imported = current()

    const reloaded = await f.reload(imported.id)
    expect(reloaded.messages).toHaveLength(2)
    expect((reloaded.messages[0] as { content: string }).content).toBe("imported one")
    expect((reloaded.messages[1] as { content: string }).content).toBe("imported two")
    f.cleanup()
  })

  test("AC4 — /compact is durable when compaction returns", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    // A compactable region: an older turn large enough that the preserved tail
    // stops before it, plus a trailing turn so the last message is not a user.
    session.pushUser("x".repeat(12_000))
    session.pushUser("y".repeat(4_000))
    session.appendAssistant([{ type: "text", text: "working" }], {})

    const outcome = await new Compactor(new FakeModel([textResponse("summary")]), 1000).compact(session)
    expect(outcome.status).toBe("compacted")

    const reloaded = await f.reload(session.id)
    const first = (reloaded.messages[0] as { content: string }).content
    expect(first).toContain("[Compacted conversation summary]")
    f.cleanup()
  })

  test("AC6 — a lifecycle mutation needs no later run to become durable", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    await seed(session)

    // Fork, then reload WITHOUT running anything, switching sessions, or
    // shutting the runtime down.
    const { ctx, current } = context(f.agent, session, "0")
    await findCommand("fork")!.execute(ctx, "")
    const forked = current()

    const reloaded = await f.reload(forked.id)
    expect(reloaded.messages).toHaveLength(1)
    f.cleanup()
  })
})

describe("run recovery ordering is unchanged (Work 3)", () => {
  test("AC5 — the pending ledger entry is durable BEFORE the tool executes", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)

    // The probe inspects the durable session while it is itself running. If an
    // interruption at this instant could not be reconciled, this is where it
    // would show: the ledger would not yet hold the in-flight call.
    let duringTool: { hasUnfinished: boolean; status: string; entries: number } | null = null
    const probe: Tool = {
      description: "inspects the durable session from inside a tool call",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const reloaded = await f.reload(session.id)
        duringTool = {
          hasUnfinished: reloaded.ledger.hasUnfinished(),
          status: reloaded.status,
          entries: reloaded.ledger.all.length,
        }
        return { ok: true, data: "probed" }
      },
    }

    await runTask({
      session,
      model: new FakeModel([
        toolCallResponse([{ toolCallId: "c1", toolName: "probe", input: {} }]),
        textResponse("done"),
      ]),
      task: "probe the durable session",
      tools: new Map([["probe", probe]]),
    })

    // The recovery contract: an interruption during tool execution leaves a
    // session the next load can reconcile. The persisted status is "running";
    // loading it converts that to "interrupted", which is exactly the state
    // recovery keys on.
    expect(duringTool).not.toBeNull()
    expect(duringTool!.hasUnfinished).toBe(true)
    expect(duringTool!.status).toBe("interrupted")
    expect(duringTool!.entries).toBe(1)
    f.cleanup()
  })

  test("AC5 — an interrupted run still reconciles on the next load", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)

    // Leave an in-flight invocation behind exactly as an interruption would.
    session.status = "running"
    session.ledger.pending({ toolCallId: "c1", name: "bash", input: { command: "echo hi" } })
    await session.checkpoint()

    const reloaded = await f.reload(session.id)
    expect(reloaded.status).toBe("interrupted")
    expect(reloaded.ledger.hasUnfinished()).toBe(true)

    // Reconciliation produces the same outcome the crash contract promises:
    // an unknown-outcome result the model can see, never a fabricated success.
    const report = await reloaded.recover()
    expect(report.reissued.length + report.unknownOutcome.length).toBeGreaterThan(0)
    expect(reloaded.ledger.hasUnfinished()).toBe(false)
    f.cleanup()
  })
})
