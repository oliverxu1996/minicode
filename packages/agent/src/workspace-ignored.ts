/**
 * Entries the agent treats as non-content when walking a workspace.
 *
 * Shared by the `find` tool and the TUI's file completion, which each carried
 * their own byte-identical copy. It lives in its own module rather than in
 * either layer because neither may depend on the other for a constant: the
 * tool layer is not the UI's business, and the UI is not the tool layer's.
 * That is the whole reason this file exists — it is not a general constants
 * module, and nothing unrelated belongs in it.
 *
 * `.minicode` holds per-project settings and trust, so it is not repository
 * content an agent should read or complete against. Spilled tool output is not
 * listed here: it lives in the OS temp directory (`tools/truncate.ts`), never
 * inside the workspace.
 */
export const IGNORED_WORKSPACE_ENTRIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".minicode",
])
