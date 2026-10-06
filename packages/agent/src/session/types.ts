import type {
  ModelAssistantPart,
  ModelFinishReason,
  ModelProtocol,
  ModelToolResult,
  ModelUsage,
} from "@minicode/model"
import type { PruneStats } from "../context/projection"
import type { ToolAffordances } from "../tools/types"

/**
 * One durable conversation entry.
 *
 * Content is exactly the canonical `@minicode/model` message shape, so a
 * session serializes to a `ModelRequest.messages` array without
 * transformation — tool calls live in assistant messages, results in
 * `role: "tool"` messages, correlated by `toolCallId`.
 *
 * `status` tracks the message lifecycle. Generation is atomic per model call,
 * so an appended message is always `complete`; a run interrupted mid-flight is
 * recorded on the SESSION (`SessionStatus`), never on the individual message.
 * The former `"interrupted"` member was unproducible — nothing ever assigned
 * it, and loading a persisted session coerces every message to `complete` —
 * so it was removed rather than left to read as a live state.
 */
export type SessionMessageStatus = "complete"

export interface BaseMessage {
  readonly id: string
  readonly timestamp: number
  /** Set at construction; never reassigned. Read-only so external holders of
   *  `Session.messages` cannot mutate durable history through a message. */
  readonly status: SessionMessageStatus
}

export interface UserMessage extends BaseMessage {
  readonly role: "user"
  readonly content: string
}

export interface AssistantMessage extends BaseMessage {
  readonly role: "assistant"
  readonly content: readonly ModelAssistantPart[]
  /** Why the model stopped (or the runtime truncated: max-iterations, doom-loop). */
  readonly finishReason?: string
}

export interface ToolMessage extends BaseMessage {
  readonly role: "tool"
  readonly content: readonly ModelToolResult[]
  /**
   * True when this turn produced an observation a repair/debugging loop may
   * depend on — e.g. a command that ran and reported a non-zero exit code.
   *
   * Agent-local and durable: request-time pruning must never withhold a
   * result on a message carrying this flag. It is *not* a model-facing field;
   * it never reaches `ModelToolResult`, so the model still sees `ok`
   * semantics and the original output text byte-for-byte.
   */
  readonly failureEvidence?: boolean
  /**
   * How to recover output a result no longer carries in full — declared by
   * whichever layer capped it (a tool's own limit, or `truncateOutput`'s
   * spill), keyed by the `toolCallId` of the result it describes.
   *
   * Keyed because one turn holds one result per tool call, and the factual unit
   * of a recovery affordance is one execution: a turn with two calls must not
   * let either result's affordance describe the other. The key is the id that
   * already correlates results to calls (`ModelToolResult.toolCallId`), so
   * "this result has no affordance" is the absence of a key rather than a value
   * a sibling could inherit.
   *
   * Agent-local and durable, exactly like {@link failureEvidence}:
   * request-time pruning reads it instead of parsing the result's prose, and
   * it is stripped before the provider sees anything.
   */
  readonly affordances?: Readonly<Record<string, ToolAffordances>>
}

export type SessionMessage = UserMessage | AssistantMessage | ToolMessage

/**
 * Durable session execution state.
 * - idle:        no run in progress
 * - running:     a run is in progress (persisted before execution starts)
 * - interrupted: a run was interrupted; recovery reconciles on next load
 */
export type SessionStatus = "idle" | "running" | "interrupted"

/**
 * Which model produced a run.
 *
 * Identity only: enough to answer "what produced this?" without carrying the
 * configuration. The endpoint and API key are deliberately absent — an
 * endpoint can embed a credential in its URL, so neither ever reaches a
 * snapshot or stdout.
 */
export interface ModelIdentity {
  /** The local, user-chosen configuration key. Unique per configuration. */
  readonly id: string
  /** Human-readable display name. */
  readonly name: string
  readonly protocol: ModelProtocol
  /** The identifier the provider API understands. */
  readonly model: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

/**
 * One run's facts, recorded on the session it ran against.
 *
 * The record is written when the run starts and completed when it reaches a
 * terminal state. Every terminal fact is optional and stays ABSENT for a run
 * that crashed or was interrupted: a run that never finished reports only what
 * was known before it died, and nothing is fabricated to fill the gap.
 */
export interface RunSummary {
  readonly id: string
  readonly startedAt: number
  /** The model this run was executed against (resolved once, per run). */
  readonly model: ModelIdentity
  /** Absent until the run reaches a terminal state. */
  readonly finishedAt?: number
  readonly finishReason?: RunFinishReason
  /** Run totals, summed over the run's model calls. Absent until finalized. */
  readonly usage?: ModelUsage
  readonly modelCalls?: number
  readonly toolCalls?: number
  /**
   * Totals across every request-pruning pass in this run: tool outputs
   * withheld to fit the input budget, and their combined original size.
   * Absent when the run never pruned anything.
   */
  readonly pruning?: PruneStats
  /** Present only when the run ended in an error. */
  readonly error?: string
}

/** Why a run ended. `stop` is the model's own final answer; the rest are
 *  runtime-enforced truncations or failures. */
export type RunFinishReason =
  | "stop"
  | "length"
  | "error"
  | "max-iterations"
  | "doom-loop"
  | "aborted"
  | "unknown"
