import type { ModelMessage } from "@minicode/model"
import { restoreFiles, type Checkpoint, type RestoreOutcome } from "./checkpoint"
import { ToolLedger } from "./ledger"
import type { Session } from "./session"
import type { RewindNote, SessionMessage } from "./types"

/**
 * Applying a checkpoint.
 *
 * The three scopes are deliberately independent: restoring the conversation
 * leaves the working tree alone even though the transcript then describes code
 * that no longer matches, and restoring files leaves the conversation alone
 * even though it discusses changes that have been undone. Both are intended
 * recovery modes, not inconsistencies to reconcile.
 *
 * Conversation restore cuts ONLY at a user-message boundary, which is the only
 * place a checkpoint exists. That keeps every retained assistant `tool_call`
 * paired with its result — the provider rejects a history where they are
 * separated — and it means the removed region is a whole number of turns.
 */

// ---------------------------------------------------------------------------
// Checkpoint lineage
//
// A checkpoint belongs to one turn, and a turn is identified by the `turnId`
// carried on the user message that began it — minted once at run start, handed
// to both the session and the recorder, and carried through every history
// rewrite. Neither of the alternatives identifies a turn: an index is reused
// the moment a rewind frees it, and a prompt is not unique (a user may send
// "continue" five times), while `replaceMessages` regenerates message ids.
//
// Two facts must agree for a checkpoint to be offered:
//
//  - the turn's message is still in the history, found BY turn id, which is
//    what makes a compaction that keeps a turn keep its checkpoint at whatever
//    position the turn now occupies;
//  - `superseded` is not set — the explicit lineage record, written by the
//    rewind or summarization that removed the turn.
//
// Anything else is not offered, so an ambiguous record is never guessed at,
// and the stored `messageIndex` is never consulted.
// ---------------------------------------------------------------------------

/**
 * Where `turnId`'s user message currently sits, or -1 when this history does
 * not contain that turn.
 *
 * The one way any checkpoint operation locates a turn. Nothing derives a
 * position from a stored index.
 */
export function turnIndexOf(messages: readonly SessionMessage[], turnId: string | undefined): number {
  if (turnId === undefined) return -1
  return messages.findIndex(message => message.role === "user" && message.turnId === turnId)
}

/**
 * Whether `checkpoint` still describes a turn present in `messages`.
 *
 * Fails closed: a record with no turn id, a malformed one, or one whose turn
 * this history no longer contains — summarized away, rewound away, or dropped
 * by a rewrite that did not carry the id — is reported as not live rather than
 * being re-anchored by guesswork.
 */
export function isLiveCheckpoint(checkpoint: Checkpoint, messages: readonly SessionMessage[]): boolean {
  if (checkpoint.superseded === true) return false
  return turnIndexOf(messages, checkpoint.turnId) >= 0
}

/** The checkpoints a picker may offer, in creation order. */
export function liveCheckpoints(
  checkpoints: readonly Checkpoint[],
  messages: readonly SessionMessage[],
): Checkpoint[] {
  return checkpoints.filter(checkpoint => isLiveCheckpoint(checkpoint, messages))
}

/**
 * The result of advancing the checkpoint list past a history rewrite.
 *
 * `next` is what to persist; `discarded` is what the rewrite removed, which is
 * what shell attribution and the session's warning are computed from.
 */
export interface CheckpointAdvance {
  readonly discarded: readonly Checkpoint[]
  readonly next: readonly Checkpoint[]
}

/**
 * Advances `checkpoints` past a rewrite that removed the turns `turnIds`.
 *
 * The ids come from the rewrite itself — it knows exactly which turns it
 * dropped — rather than from comparing indices before and after, so a turn
 * that merely moved is never mistaken for one that was removed.
 *
 * Discarded turns are tombstoned rather than deleted: the record of what a
 * turn touched is worth keeping, and the tombstone is the explicit lineage
 * statement that the turn is gone, independent of whether its id could still
 * be found somewhere.
 *
 * A checkpoint already tombstoned is left exactly as it is — it was counted by
 * the rewind that removed it, and re-attributing it to a later one would
 * double-count what that shell command did.
 */
export function discardTurns(checkpoints: readonly Checkpoint[], turnIds: readonly string[]): CheckpointAdvance {
  const removed = new Set(turnIds)
  const discarded: Checkpoint[] = []
  const next = checkpoints.map(checkpoint => {
    if (checkpoint.superseded === true) return checkpoint
    if (checkpoint.turnId === undefined || !removed.has(checkpoint.turnId)) return checkpoint
    discarded.push(checkpoint)
    return { ...checkpoint, superseded: true }
  })
  return { discarded, next }
}

/**
 * Folds what a rewind discarded into the session's standing warning.
 *
 * The counts ACCUMULATE and are never replaced or cleared by a later rewind.
 * Shell effects are not undone by anything MiniCode does afterwards, so
 * resetting the note on a rewind that happened to discard no shell turns would
 * erase a warning that is still true — the one failure this feature exists to
 * prevent. `at` records when the note last changed.
 */
export function recordRewind(session: Session, discarded: readonly Checkpoint[], now = Date.now()): void {
  if (discarded.length === 0) return
  const prior = session.rewind
  session.rewind = {
    shellTurns: (prior?.shellTurns ?? 0) + discarded.filter(c => (c.shell ?? 0) > 0).length,
    shellCommands: (prior?.shellCommands ?? 0) + discarded.reduce((total, c) => total + (c.shell ?? 0), 0),
    at: now,
  }
}

export type RewindScope = "both" | "conversation" | "code"

export interface RewindOutcome {
  /** The prompt that began the rewound turn, for the composer. */
  readonly prompt: string
  /** Messages dropped from history; 0 for a code-only rewind. */
  readonly removedMessages: number
  /** Turns this operation removed; empty for a code-only rewind. */
  readonly removedTurnIds: readonly string[]
  /** File results; `null` for a conversation-only rewind. */
  readonly files: RestoreOutcome | null
}

/**
 * A message rebuilt for `replaceMessages`, carrying its turn identity.
 *
 * `replaceMessages` regenerates ids and timestamps but keeps what it is given,
 * so the id must be handed over explicitly or the turn becomes unfindable and
 * its checkpoint silently invalid. Only a user message can begin a turn.
 */
function preservingTurn(message: SessionMessage): ModelMessage & { turnId?: string } {
  return {
    role: message.role,
    content: message.content,
    ...(message.role === "user" && message.turnId !== undefined ? { turnId: message.turnId } : {}),
  } as ModelMessage & { turnId?: string }
}

/** The turns begun by the user messages in `messages`. */
function turnIdsIn(messages: readonly SessionMessage[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (message.role === "user" && message.turnId !== undefined) ids.push(message.turnId)
  }
  return ids
}

/**
 * Restores `session` to `checkpoint` under `scope`.
 *
 * Conversation state is rewritten through `replaceMessages`, which validates
 * the candidate history and persists it in one atomic step, so the transcript
 * on disk and the in-memory session cannot disagree and a restart cannot
 * resurrect the removed turns.
 *
 * The tool ledger is rebuilt alongside it. `replaceMessages` does not touch the
 * ledger, and an entry left behind for a removed tool call is not inert: the
 * next run's recovery pass would report a phantom interrupted call to the
 * model. Entries whose call survives are kept verbatim so completed tool
 * history stays intact.
 */
export async function rewindSession(
  session: Session,
  checkpoint: Checkpoint,
  scope: RewindScope,
): Promise<RewindOutcome> {
  if (scope === "code") {
    return {
      prompt: checkpoint.prompt,
      removedMessages: 0,
      removedTurnIds: [],
      files: await restoreFiles(session.cwd, checkpoint.files),
    }
  }

  const messages = session.messages
  // The cut is where the checkpoint's OWN turn begins, located by identity in
  // the history as it stands now — never a stored index, which a compaction or
  // an earlier rewind may have invalidated.
  const boundary = turnIndexOf(messages, checkpoint.turnId)
  if (boundary < 0) throw new Error("rewind: that turn is no longer in this conversation")
  const kept = messages.slice(0, boundary)
  const removedTurnIds = turnIdsIn(messages.slice(boundary))

  const survivingCalls = new Set<string>()
  for (const message of kept) {
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "tool_call") survivingCalls.add(part.toolCallId)
    } else if (message.role === "tool") {
      for (const result of message.content) survivingCalls.add(result.toolCallId)
    }
  }
  const survivingLedger = session.ledger.toJSON().filter(entry => survivingCalls.has(entry.toolCallId))

  // Validates and persists; throws before mutating anything if the candidate
  // history is malformed, so a failed rewind leaves the session untouched.
  await session.replaceMessages(kept.map(preservingTurn))
  session.ledger.replaceAll(ToolLedger.fromJSON(survivingLedger))
  // Interrupt/recovery latches describe the history that was just discarded.
  session.forgetInterruptedState()

  const files = scope === "both" ? await restoreFiles(session.cwd, checkpoint.files) : null
  return { prompt: checkpoint.prompt, removedMessages: messages.length - boundary, removedTurnIds, files }
}

/**
 * Replaces a contiguous range of history with a summary.
 *
 * `from` is inclusive and `to` exclusive, both message indices. Everything
 * outside the range is preserved byte-for-byte, and the summary takes the
 * range's place as a single user-role message — the same shape the existing
 * compactor produces, so nothing downstream needs to know it is a summary.
 *
 * `from` must be a user-message index (or 0) and `to` must be a user-message
 * index (or the end): summarising half a turn would separate a tool call from
 * its result, which the provider rejects.
 */
export async function summarizeRange(
  session: Session,
  from: number,
  to: number,
  summarize: (messages: readonly ModelMessage[]) => Promise<string>,
): Promise<{ readonly replaced: number; readonly removedTurnIds: readonly string[] }> {
  const messages = session.messages
  const start = Math.min(Math.max(from, 0), messages.length)
  const end = Math.min(Math.max(to, start), messages.length)
  if (start === end) return { replaced: 0, removedTurnIds: [] }
  if (start > 0 && messages[start]!.role !== "user") throw new Error("summarize: range must start at a user turn")
  if (end < messages.length && messages[end]!.role !== "user") throw new Error("summarize: range must end at a user turn")

  const range = messages.slice(start, end)
  const removedTurnIds = turnIdsIn(range)
  const text = await summarize(range.map(preservingTurn))
  if (text.trim().length === 0) throw new Error("summarize: the model returned an empty summary")

  const summary: ModelMessage = { role: "user", content: `[Summary of earlier conversation]\n\n${text}` }
  // Everything outside the range is carried over with its turn identity, so a
  // turn that survives a summary keeps its checkpoint — at the position it now
  // occupies, which is found by identity rather than computed from a shift.
  const next: (ModelMessage & { turnId?: string })[] = [
    ...messages.slice(0, start).map(preservingTurn),
    summary,
    ...messages.slice(end).map(preservingTurn),
  ]

  // Only calls inside the replaced range disappear; the ledger is filtered the
  // same way a conversation rewind filters it.
  const survivingCalls = new Set<string>()
  for (const message of [...messages.slice(0, start), ...messages.slice(end)]) {
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "tool_call") survivingCalls.add(part.toolCallId)
    } else if (message.role === "tool") {
      for (const result of message.content) survivingCalls.add(result.toolCallId)
    }
  }

  await session.replaceMessages(next)
  session.ledger.replaceAll(ToolLedger.fromJSON(session.ledger.toJSON().filter(e => survivingCalls.has(e.toolCallId))))
  session.forgetInterruptedState()
  return { replaced: end - start, removedTurnIds }
}
