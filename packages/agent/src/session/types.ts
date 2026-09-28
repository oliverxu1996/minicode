import type {
  ModelAssistantPart,
  ModelFinishReason,
  ModelToolResult,
  ModelUsage,
} from "@minicode/model"

/**
 * One durable conversation entry.
 *
 * Content is exactly the canonical `@minicode/model` message shape, so a
 * session serializes to a `ModelRequest.messages` array without
 * transformation — tool calls live in assistant messages, results in
 * `role: "tool"` messages, correlated by `toolCallId`.
 *
 * `status` tracks the message lifecycle: an assistant message is appended
 * `complete` (generation is atomic per model call); `interrupted` appears
 * only through crash recovery of an in-flight run.
 */
export type SessionMessageStatus = "complete" | "interrupted"

export interface BaseMessage {
  readonly id: string
  readonly timestamp: number
  status: SessionMessageStatus
}

export interface UserMessage extends BaseMessage {
  readonly role: "user"
  readonly content: string
}

export interface AssistantMessage extends BaseMessage {
  readonly role: "assistant"
  readonly content: readonly ModelAssistantPart[]
  /** Provider-reported usage of the model call that produced this message. */
  usage?: ModelUsage
  /** Why the model stopped (or the runtime truncated: max-iterations, doom-loop). */
  finishReason?: string
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
}

export type SessionMessage = UserMessage | AssistantMessage | ToolMessage

/**
 * Durable session execution state.
 * - idle:        no run in progress
 * - running:     a run is in progress (persisted before execution starts)
 * - interrupted: a run was interrupted; recovery reconciles on next load
 */
export type SessionStatus = "idle" | "running" | "interrupted"

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

/** Observability event emitted during a run. Enough to reconstruct what
 *  happened without reading the transcript. */
export type RunEvent =
  | { type: "run_start"; sessionId: string; task: string }
  | { type: "iteration_start"; iteration: number }
  | { type: "assistant_delta"; iteration: number; text: string }
  | { type: "reasoning_delta"; iteration: number; text: string }
  | { type: "steered"; iteration: number }
  | { type: "model_response"; iteration: number; finishReason: string; usage?: ModelUsage }
  | { type: "tool_call"; iteration: number; toolCallId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_progress"; iteration: number; toolCallId: string; name: string; text: string }
  | { type: "tool_result"; iteration: number; toolCallId: string; name: string; ok: boolean; result: string }
  | { type: "compaction"; summarizedMessages: number }
  | {
      type: "auto_retry"
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  | { type: "recovery"; note: string }
  | { type: "run_end"; finishReason: RunFinishReason; iterations: number; usage?: ModelUsage; error?: string }
