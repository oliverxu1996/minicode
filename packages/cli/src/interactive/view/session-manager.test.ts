import { describe, expect, test } from "bun:test"
import { SessionManager, type SessionManagerAction } from "./session-manager"
import { stripSequences } from "./testing"
import type { ScopedSessionSummary } from "../session/scope"

function summary(overrides: Partial<ScopedSessionSummary> & { id: string }): ScopedSessionSummary {
  return {
    cwd: "/ws",
    cwdPresent: true,
    title: null,
    parentSessionId: null,
    updatedAt: Date.parse("2026-01-02T03:04:05Z"),
    messageCount: 1,
    firstUser: null,
    ...overrides,
  }
}

const CURRENT = summary({ id: "cur", title: "Project planning", messageCount: 12 })
const OTHER = summary({ id: "other", firstUser: "Fix auth", messageCount: 3 })
const THIRD = summary({ id: "third", title: null, firstUser: null, messageCount: 0 })
const CHILD = summary({ id: "child", title: "Forked work", parentSessionId: "cur", messageCount: 2 })

function open(sessions: ScopedSessionSummary[] = [CURRENT, OTHER, THIRD], currentId = "cur") {
  const actions: SessionManagerAction[] = []
  const manager = new SessionManager(sessions, currentId, "Sessions · /ws")
  manager.onAction = action => actions.push(action)
  return { manager, actions }
}

function text(manager: SessionManager): string {
  return manager.render(70).map(stripSequences).join("\n")
}

describe("SessionManager rendering", () => {
  test("shows the title, a current marker, and a label hierarchy", () => {
    const { manager } = open()
    const rendered = text(manager)
    expect(rendered).toContain("Sessions · /ws")
    expect(rendered).toContain("Project planning")
    expect(rendered).toContain("Fix auth")
    expect(rendered).toContain("(untitled)")
    // Current session carries the bullet marker.
    expect(rendered).toContain("• Project planning")
    // Secondary metadata uses only available fields.
    expect(rendered).toContain("12 msgs")
    expect(rendered).toContain("enter open")
  })

  test("marks forked/cloned children with a lineage glyph", () => {
    const { manager } = open([CURRENT, CHILD])
    expect(text(manager)).toContain("↳ Forked work")
  })

  test("windows a long list to the item cap", () => {
    const many = Array.from({ length: 30 }, (_, i) => summary({ id: `s${i}`, title: `session ${i}` }))
    const manager = new SessionManager(many, "s0", "Sessions · /ws")
    manager.setMaxVisibleItems(3)
    const lines = manager.render(70).map(stripSequences)
    // title + 3 items + hint
    expect(lines).toHaveLength(5)
  })
})

describe("SessionManager selection", () => {
  test("the current session is highlighted initially and Enter is a no-op close", () => {
    const { manager, actions } = open()
    manager.handleInput("\r")
    expect(actions).toEqual([{ kind: "close" }])
  })

  test("Enter on another session switches to it", () => {
    const { manager, actions } = open()
    manager.handleInput("\x1b[B")
    manager.handleInput("\r")
    expect(actions).toEqual([{ kind: "switch", id: "other" }])
  })

  test("Escape closes without selecting", () => {
    const { manager, actions } = open()
    manager.handleInput("\x1b")
    expect(actions).toEqual([{ kind: "close" }])
  })

  test("only the first action is emitted", () => {
    const { manager, actions } = open()
    manager.handleInput("\x1b[B")
    manager.handleInput("\r")
    manager.handleInput("\r")
    expect(actions).toHaveLength(1)
  })
})

describe("SessionManager search", () => {
  test("filters by title/firstUser case-insensitively and Enter opens the result", () => {
    const { manager, actions } = open()
    manager.handleInput("/")
    for (const ch of "AUTH") manager.handleInput(ch)
    const rendered = text(manager)
    expect(rendered).toContain("Fix auth")
    expect(rendered).not.toContain("Project planning")
    manager.handleInput("\r")
    expect(actions).toEqual([{ kind: "switch", id: "other" }])
  })

  test("reports no matches", () => {
    const { manager } = open()
    manager.handleInput("/")
    for (const ch of "zzz") manager.handleInput(ch)
    expect(text(manager)).toContain("No matching sessions")
  })

  test("Escape clears a non-empty query back to the full list, then closes", () => {
    const { manager, actions } = open()
    manager.handleInput("/")
    manager.handleInput("a")
    manager.handleInput("\x1b")
    expect(actions).toEqual([])
    expect(text(manager)).toContain("Project planning")
    manager.handleInput("\x1b")
    expect(actions).toEqual([{ kind: "close" }])
  })
})

describe("SessionManager rename", () => {
  test("emits rename for the selected session", () => {
    const { manager, actions } = open()
    manager.handleInput("r")
    expect(actions).toEqual([{ kind: "rename", id: "cur" }])
  })

  test("emits rename for a non-current selection", () => {
    const { manager, actions } = open()
    manager.handleInput("\x1b[B")
    manager.handleInput("r")
    expect(actions).toEqual([{ kind: "rename", id: "other" }])
  })
})

describe("SessionManager delete", () => {
  test("refuses to delete the current session with feedback", () => {
    const { manager, actions } = open()
    manager.handleInput("d")
    expect(actions).toEqual([])
    expect(text(manager)).toContain("cannot delete the current session")
  })

  test("requires confirmation, then emits delete", () => {
    const { manager, actions } = open()
    manager.handleInput("\x1b[B")
    manager.handleInput("d")
    expect(actions).toEqual([])
    expect(text(manager)).toContain('Delete "Fix auth"? This cannot be undone.')
    manager.handleInput("\r")
    expect(actions).toEqual([{ kind: "delete", id: "other" }])
  })

  test("Escape cancels the confirmation without deleting", () => {
    const { manager, actions } = open()
    manager.handleInput("\x1b[B")
    manager.handleInput("d")
    manager.handleInput("\x1b")
    expect(actions).toEqual([])
    expect(text(manager)).toContain("Fix auth")
  })
})

describe("SessionManager fork and clone", () => {
  test("emits fork and clone for the selected session", () => {
    const fork = open()
    fork.manager.handleInput("\x1b[B")
    fork.manager.handleInput("f")
    expect(fork.actions).toEqual([{ kind: "fork", id: "other" }])

    const clone = open()
    clone.manager.handleInput("c")
    expect(clone.actions).toEqual([{ kind: "clone", id: "cur" }])
  })
})

describe("SessionManager related sessions", () => {
  test("shows direct children and opens the selected child", () => {
    const { manager, actions } = open([CURRENT, OTHER, CHILD])
    manager.handleInput("t")
    const rendered = text(manager)
    expect(rendered).toContain("Related · Project planning")
    expect(rendered).toContain("Forked work")
    manager.handleInput("\r")
    expect(actions).toEqual([{ kind: "switch", id: "child" }])
  })

  test("related never shows a non-child session", () => {
    const { manager } = open([CURRENT, OTHER, CHILD])
    manager.handleInput("t")
    expect(text(manager)).not.toContain("Fix auth")
  })

  test("Escape returns from the related view to the session list", () => {
    const { manager, actions } = open([CURRENT, OTHER, CHILD])
    manager.handleInput("t")
    manager.handleInput("\x1b")
    expect(actions).toEqual([])
    expect(text(manager)).toContain("Fix auth")
  })

  test("reports an empty related view without entering it", () => {
    const { manager, actions } = open()
    manager.handleInput("\x1b[B")
    manager.handleInput("t")
    expect(actions).toEqual([])
    expect(text(manager)).toContain("No forked sessions under this one")
  })
})
