/**
 * Workspace scoping and filtering for the `/session` manager.
 *
 * These are pure functions over session summaries so the workspace boundary is
 * testable in isolation and applied consistently to every manager operation.
 * A session belongs to a workspace only when its snapshot actually persisted a
 * `cwd` equal to that workspace: `Session.fromJSON` defaults a missing `cwd` to
 * the loading process's directory, so an absent path must never be treated as
 * the current workspace.
 */

/** The slice of a persisted session summary the manager reasons about. */
export interface ScopedSessionSummary {
  readonly id: string
  readonly cwd: string
  /** Whether the snapshot actually persisted a `cwd` (see module note). */
  readonly cwdPresent: boolean
  readonly title: string | null
  readonly parentSessionId: string | null
  readonly updatedAt: number
  readonly messageCount: number
  readonly firstUser: string | null
}

/**
 * The candidate set for a workspace: persisted sessions whose `cwd` exactly
 * equals the workspace and was genuinely persisted. The manager never enumerates
 * globally and hides rows afterwards — this set is the source of every
 * subsequent operation.
 */
export function workspaceSessions<T extends ScopedSessionSummary>(
  summaries: readonly T[],
  workspace: string,
): T[] {
  return summaries.filter(summary => summary.cwdPresent && summary.cwd === workspace)
}

/** Direct children of `parentId` within an already workspace-scoped set. */
export function relatedSessions<T extends ScopedSessionSummary>(scoped: readonly T[], parentId: string): T[] {
  return scoped.filter(summary => summary.parentSessionId === parentId)
}

/**
 * Case-insensitive substring filter over `title` and `firstUser`, applied only
 * to the already workspace-scoped candidate set. An empty query returns the
 * full set unchanged.
 */
export function filterSessions<T extends ScopedSessionSummary>(scoped: readonly T[], query: string): T[] {
  const needle = query.toLowerCase()
  if (needle.length === 0) return [...scoped]
  return scoped.filter(summary => {
    const title = (summary.title ?? "").toLowerCase()
    const firstUser = (summary.firstUser ?? "").toLowerCase()
    return title.includes(needle) || firstUser.includes(needle)
  })
}
