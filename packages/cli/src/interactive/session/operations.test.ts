import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MiniCode, type Session } from "@minicode/agent"
import { cloneSession, forkCandidates, forkSession } from "./operations"

interface Fixture {
  readonly dir: string
  readonly sessionsDir: string
  readonly agent: MiniCode
  reload(id: string): Promise<Session>
  cleanup(): void
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "minicode-session-ops-"))
  const sessionsDir = join(dir, "sessions")
  return {
    dir,
    sessionsDir,
    agent: new MiniCode({ sessionsDir }),
    reload: async (id: string): Promise<Session> => await new MiniCode({ sessionsDir }).loadSession(id),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

async function seed(session: Session): Promise<void> {
  session.pushUser("first task")
  session.appendAssistant([{ type: "text", text: "first answer" }], { finishReason: "stop" })
  session.pushUser("second task")
}

describe("forkCandidates", () => {
  test("lists user messages in order with index and #n label", () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    // pushUser twice, assistant in between; indices reflect full history.
    session.pushUser("alpha")
    session.appendAssistant([{ type: "text", text: "reply" }], {})
    session.pushUser("beta")

    expect(forkCandidates(session)).toEqual([
      { index: 0, label: "alpha", description: "#1" },
      { index: 2, label: "beta", description: "#3" },
    ])
    f.cleanup()
  })

  test("returns nothing for a session with no user messages", () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    expect(forkCandidates(session)).toEqual([])
    f.cleanup()
  })
})

describe("forkSession", () => {
  test("copies history up to the cut, sets lineage, and is durable", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    await seed(session)

    // Candidate index 0 -> cut 1, mirroring the old `/fork` picker.
    const forked = await forkSession(f.agent, session, 1)
    expect(forked.id).not.toBe(session.id)
    expect(forked.messages).toHaveLength(1)
    expect(forked.parentSessionId).toBe(session.id)
    expect(forked.cwd).toBe(session.cwd)

    const reloaded = await f.reload(forked.id)
    expect(reloaded.parentSessionId).toBe(session.id)
    expect(reloaded.messages).toHaveLength(1)
    expect((reloaded.messages[0] as { content: string }).content).toBe("first task")
    f.cleanup()
  })

  test("does not copy assistant metadata beyond role and content", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    await seed(session)

    // cut 2 includes the assistant message, which carried finishReason "stop".
    const forked = await forkSession(f.agent, session, 2)
    const assistant = forked.messages.find(m => m.role === "assistant")
    expect(assistant).toBeDefined()
    expect((assistant as { finishReason?: string }).finishReason).toBeUndefined()
    // New durable ids, not the parent's.
    expect(forked.messages[0]!.id).not.toBe(session.messages[0]!.id)
    f.cleanup()
  })
})

describe("cloneSession", () => {
  test("copies the full history, sets lineage, and is durable", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    await seed(session)

    const clone = await cloneSession(f.agent, session)
    expect(clone.id).not.toBe(session.id)
    expect(clone.parentSessionId).toBe(session.id)
    expect(clone.cwd).toBe(session.cwd)

    const reloaded = await f.reload(clone.id)
    expect(reloaded.parentSessionId).toBe(session.id)
    expect(reloaded.messages.map(m => m.role)).toEqual(["user", "assistant", "user"])
    expect((reloaded.messages[0] as { content: string }).content).toBe("first task")
    f.cleanup()
  })
})
