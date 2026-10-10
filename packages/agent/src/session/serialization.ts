import type { ModelMessage } from "@minicode/model"
import type { ModelIdentity, RewindNote, RunSummary, SessionMessage } from "./types"

/**
 * The durable-format boundary for a session snapshot.
 *
 * These functions translate between the persisted JSON shape and the in-memory
 * durable model, and they are deliberately lenient in different directions:
 * loading an existing snapshot is defensive (malformed entries are skipped so
 * a corrupt file cannot fail the whole load), while `validateReplacementHistory`
 * is strict (a replacement is a durable rewrite, so anything the loader would
 * not faithfully round-trip is rejected before it is applied).
 *
 * Keeping them together makes the "what may become durable history?" question
 * answerable in one place, and keeps `Session` focused on behaviour rather than
 * parsing.
 */

/** Parses persisted messages, dropping anything the durable model cannot hold. */
export function parseMessages(input: unknown): SessionMessage[] {
  if (!Array.isArray(input)) return []
  const out: SessionMessage[] = []
  for (const raw of input) {
    const msg = raw as Partial<SessionMessage>
    if (typeof msg !== "object" || msg === null) continue
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "tool") continue
    // A turn id that is not a string is not an identity. Dropping it leaves the
    // message loadable and its checkpoints provably unusable, which is the
    // safe direction; keeping a malformed value would let it match something.
    if (typeof (msg as { turnId?: unknown }).turnId !== "string") delete (msg as { turnId?: unknown }).turnId
    out.push({
      ...msg,
      id: typeof msg.id === "string" ? msg.id : crypto.randomUUID(),
      status: "complete",
      timestamp: typeof msg.timestamp === "number" ? msg.timestamp : 0,
    } as SessionMessage)
  }
  return out
}

/** Parses persisted run records; anything malformed is skipped rather than
 *  failing the whole session load. */
export function parseRuns(input: unknown): RunSummary[] {
  if (!Array.isArray(input)) return []
  const out: RunSummary[] = []
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue
    const run = raw as Partial<RunSummary>
    const model = run.model as Partial<ModelIdentity> | undefined
    if (typeof run.id !== "string" || typeof run.startedAt !== "number") continue
    if (typeof model !== "object" || model === null || typeof model.id !== "string") continue
    out.push(raw as RunSummary)
  }
  return out
}

/**
 * Parses the persisted rewind note.
 *
 * Anything malformed loads as `null` rather than failing the session: a
 * missing warning is a smaller failure than an unloadable session, and the
 * note is never load-bearing for the transcript itself.
 */
export function parseRewindNote(input: unknown): RewindNote | null {
  if (typeof input !== "object" || input === null) return null
  const note = input as Partial<RewindNote>
  const values = [note.shellTurns, note.shellCommands, note.at]
  if (!values.every(value => typeof value === "number" && Number.isFinite(value))) return null
  return { shellTurns: note.shellTurns!, shellCommands: note.shellCommands!, at: note.at! }
}

/**
 * Validates a candidate history for {@link Session.replaceMessages}.
 *
 * `replaceMessages` is the durable rewrite door used by compaction, fork,
 * clone and `/import`. It accepts `ModelMessage[]`, a shape that admits roles
 * and payloads the durable format cannot faithfully represent (the loader's
 * `parseMessages` silently drops any role but user/assistant/tool). Anything
 * accepted here must round-trip through `toJSON`/`fromJSON` unchanged, so the
 * rules below reject exactly what the durable format cannot carry:
 *
 *  - roles must be one of `user`, `assistant`, `tool`;
 *  - each message must have the declared shape for its role (string user
 *    content; assistant parts; tool results with a known output kind);
 *  - a tool call/result `toolCallId` must be a non-empty string;
 *  - one `toolCallId` may have at most one durable result.
 *
 * A dangling assistant tool call (no result) is deliberately valid: interrupted
 * and steered runs leave exactly that, and `recover` reconciles it. Validation
 * therefore never requires a call to have a result.
 *
 * Throws before any mutation; callers must treat a throw as "nothing changed".
 */
export function validateReplacementHistory(messages: readonly ModelMessage[]): void {
  const seenResultIds = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as { role?: unknown } | null | undefined
    if (typeof message !== "object" || message === null) {
      throw new Error(`replaceMessages: message ${i} is not an object`)
    }
    if (message.role === "user") {
      if (typeof (message as { content?: unknown }).content !== "string") {
        throw new Error(`replaceMessages: user message ${i} content must be a string`)
      }
      continue
    }
    if (message.role === "assistant") {
      const content = (message as { content?: unknown }).content
      // A plain string is the transcript form `/import` accepts and the
      // durable loader preserves verbatim; parts are the runtime form.
      if (typeof content === "string") continue
      if (!Array.isArray(content)) {
        throw new Error(`replaceMessages: assistant message ${i} content must be a string or an array of parts`)
      }
      content.forEach((raw, p) => {
        const part = raw as { type?: unknown; text?: unknown; toolCallId?: unknown; toolName?: unknown } | null
        if (part === null || typeof part !== "object") {
          throw new Error(`replaceMessages: assistant message ${i} part ${p} is not an object`)
        }
        if (part.type === "text") {
          if (typeof part.text !== "string") {
            throw new Error(`replaceMessages: assistant message ${i} text part ${p} needs a string text`)
          }
        } else if (part.type === "tool_call") {
          if (typeof part.toolCallId !== "string" || part.toolCallId.length === 0) {
            throw new Error(`replaceMessages: assistant message ${i} tool call ${p} needs a non-empty toolCallId`)
          }
          if (typeof part.toolName !== "string") {
            throw new Error(`replaceMessages: assistant message ${i} tool call ${p} needs a toolName`)
          }
        } else {
          throw new Error(`replaceMessages: assistant message ${i} part ${p} has an unsupported type`)
        }
      })
      continue
    }
    if (message.role === "tool") {
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) {
        throw new Error(`replaceMessages: tool message ${i} content must be an array`)
      }
      content.forEach((raw, r) => {
        const result = raw as { toolCallId?: unknown; toolName?: unknown; output?: unknown } | null
        if (result === null || typeof result !== "object") {
          throw new Error(`replaceMessages: tool message ${i} result ${r} is not an object`)
        }
        if (typeof result.toolCallId !== "string" || result.toolCallId.length === 0) {
          throw new Error(`replaceMessages: tool message ${i} result ${r} needs a non-empty toolCallId`)
        }
        if (seenResultIds.has(result.toolCallId)) {
          throw new Error(`replaceMessages: duplicate tool result for toolCallId ${result.toolCallId}`)
        }
        seenResultIds.add(result.toolCallId)
        if (typeof result.toolName !== "string") {
          throw new Error(`replaceMessages: tool message ${i} result ${r} needs a toolName`)
        }
        const output = result.output as { type?: unknown; text?: unknown } | null | undefined
        if (output === null || typeof output !== "object") {
          throw new Error(`replaceMessages: tool message ${i} result ${r} needs an output`)
        }
        if (output.type === "text" || output.type === "tool_error") {
          if (typeof output.text !== "string") {
            throw new Error(`replaceMessages: tool message ${i} result ${r} ${output.type} output needs a string text`)
          }
        } else if (output.type !== "json") {
          throw new Error(`replaceMessages: tool message ${i} result ${r} has an unsupported output type`)
        }
      })
      continue
    }
    throw new Error(`replaceMessages: message ${i} has unsupported durable role ${String(message.role)}`)
  }
}
