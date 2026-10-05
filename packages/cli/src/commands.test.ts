import { describe, expect, test } from "bun:test"
import { COMMANDS, findCommand } from "./commands"

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
