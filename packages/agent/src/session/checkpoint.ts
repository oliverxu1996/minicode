import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

/**
 * File checkpoints for `/rewind`.
 *
 * A checkpoint records the *pre-mutation* state of every file an agent turn
 * changed, captured at the mutation boundary (immediately before the tool that
 * writes it runs) rather than reconstructed from tool-call text afterwards.
 * The post-mutation state is recorded too, at the end of the turn, so a
 * restore can tell "nothing touched this since the agent did" from "something
 * changed this file after the agent did" and refuse to clobber the latter.
 *
 * Scope and honesty:
 *  - Only paths the agent's own file tools target are tracked. Shell commands
 *    and any other process can write anything and are NOT tracked; the
 *    restore path says so rather than implying the tree is fully restored.
 *    A turn's shell INVOCATIONS are counted (never their effects), so a rewind
 *    can tell the user that something ran whose consequences it cannot undo.
 *  - Only regular files are tracked. Symlinks, directories, sockets and
 *    devices are refused, so a restore can never follow a link out of the
 *    project or replace something that is not an ordinary file.
 *  - Binary and oversized files are recorded as "not restorable" instead of
 *    being decoded lossily.
 */

/** The state of one path at a point in time. */
export interface FileState {
  readonly existed: boolean
  /** Text content, or `null` when the file did not exist or cannot be restored. */
  readonly content: string | null
  /** POSIX mode, or `null` when unknown/not applicable. */
  readonly mode: number | null
  /**
   * Why this file cannot be restored, when it cannot: `binary`, `too-large`,
   * `symlink`, `directory`, `outside-workspace`.
   */
  readonly unrestorable?: string
}

/** One tracked path within a turn. */
export interface FileChange {
  /** Path relative to the session workspace, using `/` separators. */
  readonly path: string
  readonly before: FileState
  /** State at the end of the turn; absent while the turn is still running. */
  readonly after?: FileState
}

/** A boundary before one user turn. */
export interface Checkpoint {
  readonly id: string
  /**
   * The user prompt that began the turn — the exact text pushed as its user
   * message, so it doubles as the record's anchor in the conversation (see
   * `isLiveCheckpoint`).
   */
  readonly prompt: string
  /**
   * Where this turn's user message sat when the checkpoint was opened.
   *
   * Diagnostics and legacy loading ONLY: an index is not an identity, since a
   * rewind frees indices that the next turn reuses. Nothing may use it to
   * decide eligibility or where to cut — `turnId` is located in the live
   * history instead.
   */
  readonly messageIndex: number
  /**
   * The turn this checkpoint belongs to — the `turnId` carried by the user
   * message that began it. This, not the index or the prompt, is the identity.
   * Absent on records written before turn identity existed, which are
   * therefore never offered.
   */
  readonly turnId?: string
  readonly createdAt: number
  readonly files: readonly FileChange[]
  /**
   * Shell commands this turn invoked, or absent for a record written before
   * they were counted. It records that a shell RAN, not that it changed
   * anything: an invocation's effects cannot be determined from here, and a
   * stored 0 is a fact (the turn ran none) rather than an absence of evidence.
   */
  readonly shell?: number
  /**
   * Set when this checkpoint's turn was removed from the conversation. A
   * tombstone is the lineage record a rewind writes for what it discarded, so
   * a later turn reusing the same message index can never revive this one.
   */
  readonly superseded?: boolean
}

/** Files larger than this are recorded but never restored. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

/** Resolves a tool-supplied path to an absolute path, or `null` when it escapes the workspace. */
export function resolveInWorkspace(cwd: string, path: string): string | null {
  const root = resolve(cwd)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  if (target === root) return null
  const rel = relative(root, target)
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null
  return target
}

/** The workspace-relative, `/`-separated form of an absolute path. */
export function toWorkspacePath(cwd: string, absolute: string): string {
  return relative(resolve(cwd), absolute).split(sep).join("/")
}

/**
 * Reads the state of `absolute` for checkpointing.
 *
 * Never follows a symlink: a link is reported as unrestorable rather than
 * being read through, so a restore cannot write outside the workspace by
 * following one.
 */
export async function readFileState(absolute: string): Promise<FileState> {
  let stats
  try {
    stats = await lstat(absolute)
  } catch {
    return { existed: false, content: null, mode: null }
  }
  if (stats.isSymbolicLink()) return { existed: true, content: null, mode: null, unrestorable: "symlink" }
  if (stats.isDirectory()) return { existed: true, content: null, mode: null, unrestorable: "directory" }
  if (!stats.isFile()) return { existed: true, content: null, mode: null, unrestorable: "not-a-file" }
  if (stats.size > MAX_SNAPSHOT_BYTES) return { existed: true, content: null, mode: stats.mode & 0o777, unrestorable: "too-large" }
  let content: string
  try {
    content = await readFile(absolute, "utf-8")
  } catch {
    return { existed: true, content: null, mode: stats.mode & 0o777, unrestorable: "unreadable" }
  }
  // A NUL byte means this is not text; storing it as a string would corrupt it.
  if (content.includes("\u0000")) return { existed: true, content: null, mode: stats.mode & 0o777, unrestorable: "binary" }
  return { existed: true, content, mode: stats.mode & 0o777 }
}

export interface RestoreOutcome {
  readonly restored: readonly string[]
  readonly removed: readonly string[]
  readonly failed: readonly { readonly path: string; readonly reason: string }[]
  /** Paths the user (or anything else) changed after the agent did; left alone. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
}

/**
 * Restores `files` under `cwd` to their checkpoint (`before`) state.
 *
 * Every file is decided independently: one refusal never aborts the rest, and
 * the outcome names exactly what happened to each path. A file whose current
 * content differs from the turn's own post-state was changed by something
 * outside the agent, so it is skipped rather than overwritten.
 */
export async function restoreFiles(cwd: string, files: readonly FileChange[]): Promise<RestoreOutcome> {
  const restored: string[] = []
  const removed: string[] = []
  const failed: { path: string; reason: string }[] = []
  const skipped: { path: string; reason: string }[] = []

  for (const file of files) {
    const absolute = resolveInWorkspace(cwd, file.path)
    if (absolute === null) {
      failed.push({ path: file.path, reason: "outside the workspace" })
      continue
    }
    if (file.before.unrestorable !== undefined) {
      failed.push({ path: file.path, reason: `not restorable (${file.before.unrestorable})` })
      continue
    }

    const current = await readFileState(absolute)
    if (current.unrestorable === "symlink") {
      failed.push({ path: file.path, reason: "the path is now a symlink" })
      continue
    }

    // Conflict check: only meaningful once the turn recorded its post-state.
    const after = file.after
    if (after !== undefined && !after.unrestorable) {
      const unchangedSinceAgent = current.existed === after.existed && current.content === after.content
      if (!unchangedSinceAgent) {
        skipped.push({ path: file.path, reason: "changed after the agent did — left untouched" })
        continue
      }
    }

    try {
      if (!file.before.existed) {
        // The agent created it; rewinding removes it.
        if (current.existed) {
          await rm(absolute, { force: true })
          removed.push(file.path)
        }
      } else {
        await mkdir(dirname(absolute), { recursive: true })
        await writeFileAtomically(absolute, file.before.content ?? "")
        if (file.before.mode !== null) await chmod(absolute, file.before.mode)
        restored.push(file.path)
      }
    } catch (err) {
      failed.push({ path: file.path, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return { restored, removed, failed, skipped }
}

/** Writes via a temporary file so a crash cannot leave a half-written file. */
async function writeFileAtomically(absolute: string, content: string): Promise<void> {
  const temp = `${absolute}.minicode-rewind-${crypto.randomUUID()}`
  await writeFile(temp, content, "utf-8")
  await rename(temp, absolute)
}

/** The sidecar file holding a session's checkpoints. */
export function checkpointsPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.checkpoints.json`)
}

/**
 * Reads and writes a session's checkpoints.
 *
 * One sidecar file per session, written atomically, so a crash mid-write
 * cannot corrupt the list. An unreadable or malformed file yields no
 * checkpoints rather than throwing: `/rewind` then reports that there is
 * nothing to rewind to, which is honest and never blocks the session.
 */
export class CheckpointStore {
  constructor(private readonly sessionsDir: string) {}

  private path(sessionId: string): string {
    return checkpointsPath(this.sessionsDir, sessionId)
  }

  async load(sessionId: string): Promise<Checkpoint[]> {
    try {
      const raw = await readFile(this.path(sessionId), "utf-8")
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isCheckpoint).map(withKnownShellCount)
    } catch {
      return []
    }
  }

  async save(sessionId: string, checkpoints: readonly Checkpoint[]): Promise<void> {
    const target = this.path(sessionId)
    // The directory may not exist yet on a first run in a fresh config dir.
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.tmp-${crypto.randomUUID()}`
    await writeFile(temp, JSON.stringify(checkpoints, null, 2), "utf-8")
    await rename(temp, target)
  }
}

/** Structural check for a persisted checkpoint; a bad entry is dropped, not trusted. */
function isCheckpoint(value: unknown): value is Checkpoint {
  if (typeof value !== "object" || value === null) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.id === "string"
    && typeof c.prompt === "string"
    && typeof c.messageIndex === "number"
    && typeof c.createdAt === "number"
    && Array.isArray(c.files)
    // A record whose turn identity is malformed cannot be proven to belong to
    // any turn, so it is dropped rather than kept as a value that might match.
    && (c.turnId === undefined || typeof c.turnId === "string")
  )
}

/**
 * Whether a tool runs an arbitrary shell command.
 *
 * `bash` is the only one: every other tool either names the file it edits
 * (`write`, `edit`) or reads. Shell-mediated changes are therefore counted as
 * invocations and never attributed to a path.
 */
export function isShellTool(toolName: string): boolean {
  return toolName === "bash"
}

/**
 * Drops a shell count that is not a number.
 *
 * An unreadable count is an UNKNOWN count, not a zero: left as a corrupt value
 * it would compare as "no shell ran", which is a claim the record cannot
 * support. Absent is the honest form of unknown, and the restore report says
 * so in those words.
 */
function withKnownShellCount(checkpoint: Checkpoint): Checkpoint {
  if (checkpoint.shell === undefined || Number.isFinite(checkpoint.shell)) return checkpoint
  return { ...checkpoint, shell: undefined }
}

/** Tool inputs that name a file the tool will mutate. */
export function mutationTargets(toolName: string, input: unknown): string[] {
  if (typeof input !== "object" || input === null) return []
  const record = input as Record<string, unknown>
  if (toolName === "write" || toolName === "edit") {
    const path = record.filePath ?? record.path
    return typeof path === "string" && path.length > 0 ? [path] : []
  }
  // `bash` runs an arbitrary shell command and every other tool is read-only,
  // so neither can be attributed to a path here. Shell-mediated writes are
  // therefore NOT checkpointed; the restore report says so.
  return []
}

/**
 * Records the pre-mutation state of files an agent turn changes.
 *
 * One recorder serves a whole process. A turn opens when its user message is
 * pushed and closes when the run ends, so a turn that contains several
 * assistant messages and many tool calls produces exactly ONE checkpoint —
 * the boundary a user means by "go back to before I asked that".
 *
 * Every completed turn gets one: the conversation is the primary thing a
 * rewind restores, so a turn that touched no file is a rarer record, not a
 * lesser one. What each record adds beyond the boundary is what that turn
 * happened to change — nothing, for a plain exchange.
 *
 * Files are captured the first time the turn touches them (`before`) and
 * re-read when the turn closes (`after`). The `after` state is what lets a
 * restore tell an untouched file from one the user edited afterwards.
 */
export class RewindRecorder {
  /** sessionId → the checkpoint currently being built, if a turn is open. */
  private readonly open = new Map<string, { checkpoint: Checkpoint; seen: Set<string>; shell: number }>()

  constructor(private readonly store: CheckpointStore) {}

  /**
   * Opens a checkpoint for a turn.
   *
   * `messageIndex` is where this turn's user message will sit in the session's
   * history — the caller reads it immediately before pushing that message, so
   * the boundary and the transcript can never disagree.
   *
   * `turnId` must be the SAME value the caller gives `Session.pushUser` for
   * that message. It is required rather than defaulted: two independently
   * minted ids would silently produce a checkpoint that can never match its
   * own turn.
   */
  async beginTurn(sessionId: string, prompt: string, messageIndex: number, turnId: string): Promise<void> {
    if (this.open.has(sessionId)) return // a turn is already open; never nest
    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      prompt,
      messageIndex,
      turnId,
      createdAt: Date.now(),
      files: [],
    }
    this.open.set(sessionId, { checkpoint, seen: new Set(), shell: 0 })
  }

  /** Captures pre-mutation state for a tool call, before it runs. */
  async beforeTool(sessionId: string, workspace: string, toolName: string, input: unknown): Promise<void> {
    const active = this.open.get(sessionId)
    if (active === undefined) return
    // Counted before execution: an invocation that fails, times out or is
    // interrupted may still have had effects, so the fact that a shell ran is
    // recorded even when its outcome never came back.
    if (isShellTool(toolName)) active.shell += 1
    for (const target of mutationTargets(toolName, input)) {
      const absolute = resolveInWorkspace(workspace, target)
      if (absolute === null) continue // outside the workspace: never tracked, never restored
      const path = toWorkspacePath(workspace, absolute)
      if (active.seen.has(path)) continue // the turn's first sight of it is the checkpoint
      active.seen.add(path)
      const before = await readFileState(absolute)
      ;(active.checkpoint.files as FileChange[]).push({ path, before })
    }
  }

  /** Closes the open turn, records post-state, and persists the checkpoint. */
  async endTurn(sessionId: string, workspace: string): Promise<void> {
    const active = this.open.get(sessionId)
    if (active === undefined) return
    this.open.delete(sessionId)

    // Every completed turn is recorded, including one that called no tool and
    // changed nothing. `/rewind` restores the CONVERSATION first — a plain
    // exchange is a boundary a user means to go back to ("take that message
    // back and let me rephrase it"), and a record that only exists when a file
    // changed makes the picker empty in exactly that case. A turn with no tool
    // calls simply records no files and no shell invocations.
    const files: FileChange[] = []
    for (const file of active.checkpoint.files) {
      const absolute = resolveInWorkspace(workspace, file.path)
      const after = absolute === null ? undefined : await readFileState(absolute)
      files.push(after === undefined ? file : { ...file, after })
    }
    const checkpoint: Checkpoint = { ...active.checkpoint, files, shell: active.shell }
    const all = await this.store.load(sessionId)
    all.push(checkpoint)
    await this.store.save(sessionId, all)
  }

  /** Abandons an open turn without recording it (used when nothing ran). */
  abandon(sessionId: string): void {
    this.open.delete(sessionId)
  }
}
