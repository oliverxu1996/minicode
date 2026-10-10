/**
 * Work 3 — Session checkpoint ownership (application half).
 *
 * The invariant under test throughout: after a lifecycle command returns, the
 * resulting session is ALREADY durable. Every test discards the in-memory
 * object and reloads from disk through a fresh runtime, because that is the
 * only way to tell "durable" from "still in memory".
 *
 * The runtime-level compaction and recovery tests live with the runtime in
 * `@loongcode/agent`.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LoongCode, type Session } from "@loongcode/agent"
import { cloneSession, forkSession } from "./session/operations"

interface Fixture {
  readonly dir: string
  readonly sessionsDir: string
  readonly agent: LoongCode
  /** A second runtime over the same store — "the process restarted". */
  reload(id: string): Promise<Session>
  cleanup(): void
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "loongcode-lifecycle-"))
  const sessionsDir = join(dir, "sessions")
  const agent = new LoongCode({ sessionsDir })
  return {
    dir,
    sessionsDir,
    agent,
    reload: async (id: string): Promise<Session> =>
      await new LoongCode({ sessionsDir }).loadSession(id),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

async function seed(session: Session): Promise<void> {
  session.pushUser("first task")
  session.appendAssistant([{ type: "text", text: "first answer" }], {})
  session.pushUser("second task")
}

describe("session lifecycle durability (Work 3)", () => {
  test("AC1 — a fork is durable when it returns", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    await seed(session)

    // `/session` fork: cut after the first user message (index 0 -> cut 1).
    const forked = await forkSession(f.agent, session, 1)
    expect(forked.id).not.toBe(session.id)

    // Reload through a fresh runtime: nothing else may be required.
    const reloaded = await f.reload(forked.id)
    expect(reloaded.id).toBe(forked.id)
    expect(reloaded.parentSessionId).toBe(session.id)
    expect(reloaded.messages).toHaveLength(1)
    expect((reloaded.messages[0] as { content: string }).content).toBe("first task")
    f.cleanup()
  })

  test("AC2 — a clone is durable when it returns", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    await seed(session)

    const clone = await cloneSession(f.agent, session)
    expect(clone.id).not.toBe(session.id)

    const reloaded = await f.reload(clone.id)
    expect(reloaded.parentSessionId).toBe(session.id)
    expect(reloaded.messages.map(m => m.role)).toEqual(["user", "assistant", "user"])
    expect((reloaded.messages[0] as { content: string }).content).toBe("first task")
    f.cleanup()
  })

  test("AC6 — a lifecycle mutation needs no later run to become durable", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    await seed(session)

    // Fork, then reload WITHOUT running anything, switching sessions, or
    // shutting the runtime down.
    const forked = await forkSession(f.agent, session, 1)

    const reloaded = await f.reload(forked.id)
    expect(reloaded.messages).toHaveLength(1)
    f.cleanup()
  })
})
