import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MiniCode } from "../../src/minicode"

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "minicode-session-store-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("MiniCode.deleteSession", () => {
  test("removes the snapshot and evicts the cached session", async () => {
    const { dir, cleanup } = tempDir()
    const sessionsDir = join(dir, "sessions")
    const agent = new MiniCode({ sessionsDir })
    const session = agent.createSession(join(dir, "ws"))
    session.pushUser("hello")
    await session.checkpoint()

    // Warm the in-memory cache through the same runtime.
    expect(await agent.loadSession(session.id)).toBe(session)

    await agent.deleteSession(session.id)

    expect((await agent.sessionSummaries()).map(s => s.id)).not.toContain(session.id)
    // The cache was evicted, so a load cannot resurrect it from memory...
    await expect(agent.loadSession(session.id)).rejects.toBeDefined()
    // ...and a fresh runtime cannot resurrect it from disk.
    await expect(new MiniCode({ sessionsDir }).loadSession(session.id)).rejects.toBeDefined()
    cleanup()
  })

  test("deleting an already-absent session is a no-op", async () => {
    const { dir, cleanup } = tempDir()
    const agent = new MiniCode({ sessionsDir: join(dir, "sessions") })
    await agent.deleteSession("does-not-exist")
    expect(await agent.sessionSummaries()).toEqual([])
    cleanup()
  })
})

describe("sessionSummaries cwd provenance", () => {
  test("distinguishes a persisted cwd from one defaulted on load", async () => {
    const { dir, cleanup } = tempDir()
    const sessionsDir = join(dir, "sessions")
    const agent = new MiniCode({ sessionsDir })
    const session = agent.createSession(join(dir, "ws"))
    session.pushUser("hi")
    await session.checkpoint()

    // A legacy snapshot with no `cwd`: Session.fromJSON defaults it to the
    // loading process's directory, so the summary must flag it as not persisted.
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      join(sessionsDir, "legacy.json"),
      JSON.stringify({ version: 1, id: "legacy", status: "idle", messages: [] }),
    )

    const summaries = await agent.sessionSummaries()
    const persisted = summaries.find(s => s.id === session.id)
    const legacy = summaries.find(s => s.id === "legacy")
    expect(persisted?.cwdPresent).toBe(true)
    expect(persisted?.cwd).toBe(join(dir, "ws"))
    expect(legacy?.cwdPresent).toBe(false)
    cleanup()
  })
})
