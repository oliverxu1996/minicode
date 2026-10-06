import { describe, expect, test } from "bun:test"
import { COMMANDS, findCommand, type CommandContext, type CompactResult } from "./commands"

describe("commands (AC12)", () => {
  test("core commands exist with descriptions", () => {
    const names = COMMANDS.map(c => c.name)
    for (const name of ["help", "model", "login", "logout", "new", "resume", "name", "session", "compact", "copy", "export", "import", "trust", "reload", "fork", "clone", "tree", "hotkeys", "quit"]) {
      expect(names).toContain(name)
    }
    expect(findCommand("model")?.description.length).toBeGreaterThan(0)
    expect(findCommand("nonexistent")).toBeUndefined()
  })
})

/** A command context whose `compact()` returns a scripted result. */
function compactContext(result: CompactResult): { ctx: CommandContext; notices: string[] } {
  const notices: string[] = []
  const ctx = {
    compact: async () => result,
    notify: (text: string) => { notices.push(text) },
  } as unknown as CommandContext
  return { ctx, notices }
}

describe("/compact busy handling", () => {
  test("a compaction already in progress is reported, not started again", async () => {
    const { ctx, notices } = compactContext({ status: "busy", reason: "compacting" })
    await findCommand("compact")!.execute(ctx, "")
    expect(notices).toEqual(["a compaction is already in progress"])
  })

  test("compacting during a run is refused with a distinct message", async () => {
    const { ctx, notices } = compactContext({ status: "busy", reason: "running" })
    await findCommand("compact")!.execute(ctx, "")
    expect(notices).toEqual(["a task is running — wait for it to finish before compacting"])
  })
})

describe("/quit lifecycle", () => {
  test("uses the UI shutdown hook instead of exiting the process directly", async () => {
    // The fullscreen renderer must be stopped through the UI lifecycle so the
    // alternate screen and mouse state are restored before the process exits.
    let quitCalls = 0
    const ctx = {
      quit: () => {
        quitCalls += 1
      },
    } as unknown as CommandContext
    await findCommand("quit")!.execute(ctx, "")
    expect(quitCalls).toBe(1)
  })
})

describe("/hotkeys documentation", () => {
  test("advertises the current submit/newline keys and no follow-up queue", async () => {
    const notices: string[] = []
    const ctx = { notify: (text: string) => { notices.push(text) } } as unknown as CommandContext

    await findCommand("hotkeys")!.execute(ctx, "")

    expect(notices).toHaveLength(1)
    const text = notices[0]!

    // The retired Alt+Enter follow-up queue must not be advertised anymore.
    expect(text).not.toMatch(/queue/i)
    expect(text).not.toMatch(/follow[\s-]?up/i)

    // Enter submits; Alt+Enter / Shift+Enter / Ctrl+J insert a newline.
    const submitLine = text.split("\n")[0]!
    expect(submitLine).toContain("enter — submit")
    expect(submitLine).toContain("alt+enter")
    expect(submitLine).toContain("shift+enter")
    expect(submitLine).toContain("ctrl+j")
    expect(submitLine).toContain("newline")
  })
})

describe("selector commands share the picker path", () => {
  test("every picker caller routes through ctx.pick with its title", async () => {
    // All five commands route through ctx.pick, and the application renders the
    // returned selector in the shared bottom-attached picker slot, so the
    // presentation applies uniformly rather than per command.
    const pickedTitles: string[] = []
    const now = Date.now()
    const summary = {
      id: "s1",
      title: "existing",
      firstUser: "hi",
      messageCount: 2,
      updatedAt: now,
      parentSessionId: "current",
    }
    const userMessage = { id: "u1", role: "user", content: "hello", status: "complete", timestamp: 1 }
    const ctx = {
      agent: () => ({
        modelManager: async () => ({ list: () => [{ id: "m1" }, { id: "m2" }] }),
        currentModel: async () => ({ id: "m1" }),
        removeModel: () => {},
        sessionSummaries: async () => [summary],
        loadSession: async () => ({}),
        createSession: () => ({}),
      }),
      session: () => ({ id: "current", cwd: "/tmp", messages: [userMessage], status: "idle" }),
      pick: async (title: string) => {
        pickedTitles.push(title)
        return null
      },
      notify: () => {},
      setSession: () => {},
    } as unknown as CommandContext

    await findCommand("model")!.execute(ctx, "")
    await findCommand("logout")!.execute(ctx, "")
    await findCommand("resume")!.execute(ctx, "")
    await findCommand("fork")!.execute(ctx, "")
    await findCommand("tree")!.execute(ctx, "")

    expect(pickedTitles).toEqual([
      "Select model",
      "Remove model",
      "Resume session",
      "Fork from message",
      "Forked sessions",
    ])
  })
})
