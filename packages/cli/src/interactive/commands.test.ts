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
