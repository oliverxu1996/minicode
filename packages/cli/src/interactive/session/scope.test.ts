import { describe, expect, test } from "bun:test"
import { filterSessions, relatedSessions, workspaceSessions, type ScopedSessionSummary } from "./scope"

function summary(overrides: Partial<ScopedSessionSummary> & { id: string }): ScopedSessionSummary {
  return {
    cwd: "/ws",
    cwdPresent: true,
    title: null,
    parentSessionId: null,
    updatedAt: 0,
    messageCount: 0,
    firstUser: null,
    ...overrides,
  }
}

describe("workspaceSessions", () => {
  test("keeps only sessions whose persisted cwd exactly matches the workspace", () => {
    const summaries = [
      summary({ id: "a", cwd: "/ws" }),
      summary({ id: "b", cwd: "/other" }),
      summary({ id: "c", cwd: "/ws/nested" }),
    ]
    expect(workspaceSessions(summaries, "/ws").map(s => s.id)).toEqual(["a"])
  })

  test("excludes sessions whose cwd was not persisted", () => {
    const summaries = [
      summary({ id: "a", cwd: "/ws", cwdPresent: false }),
      summary({ id: "b", cwd: "/ws", cwdPresent: true }),
    ]
    expect(workspaceSessions(summaries, "/ws").map(s => s.id)).toEqual(["b"])
  })

  test("does not normalize paths: a trailing slash is a different workspace", () => {
    const summaries = [summary({ id: "a", cwd: "/ws/" })]
    expect(workspaceSessions(summaries, "/ws")).toEqual([])
  })
})

describe("relatedSessions", () => {
  test("returns direct children only, within the scoped set", () => {
    const scoped = [
      summary({ id: "parent" }),
      summary({ id: "child-1", parentSessionId: "parent" }),
      summary({ id: "child-2", parentSessionId: "parent" }),
      summary({ id: "grandchild", parentSessionId: "child-1" }),
      summary({ id: "unrelated", parentSessionId: "elsewhere" }),
    ]
    expect(relatedSessions(scoped, "parent").map(s => s.id)).toEqual(["child-1", "child-2"])
  })

  test("never returns a child recorded under a session outside the scope", () => {
    const scoped = [summary({ id: "only" })]
    expect(relatedSessions(scoped, "foreign-parent")).toEqual([])
  })
})

describe("filterSessions", () => {
  const scoped = [
    summary({ id: "a", title: "Project planning" }),
    summary({ id: "b", firstUser: "Fix authentication bug" }),
    summary({ id: "c", title: null, firstUser: null }),
  ]

  test("matches title and firstUser, case-insensitively", () => {
    expect(filterSessions(scoped, "PLAN").map(s => s.id)).toEqual(["a"])
    expect(filterSessions(scoped, "AUTH").map(s => s.id)).toEqual(["b"])
  })

  test("an empty query returns the whole scoped set", () => {
    expect(filterSessions(scoped, "").map(s => s.id)).toEqual(["a", "b", "c"])
  })

  test("no match yields an empty list", () => {
    expect(filterSessions(scoped, "zzz")).toEqual([])
  })

  test("search only ever narrows the scoped set", () => {
    const matched = filterSessions(scoped, "a")
    expect(matched.every(s => scoped.includes(s))).toBe(true)
  })
})
