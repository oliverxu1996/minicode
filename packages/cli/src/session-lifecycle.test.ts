/**
 * Work 3 — Session checkpoint ownership (application half).
 *
 * The invariant under test throughout: after a lifecycle command returns, the
 * resulting session is ALREADY durable. Every test discards the in-memory
 * object and reloads from disk through a fresh runtime, because that is the
 * only way to tell "durable" from "still in memory".
 *
 * The runtime-level compaction and recovery tests live with the runtime in
 * `@minicode/agent`.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MiniCode, type Session } from "@minicode/agent"
import { findCommand, type CommandContext } from "./commands"

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
  const agent = new MiniCode({ sessionsDir })
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
