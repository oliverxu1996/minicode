import type { ModelMessage, ModelToolOutput, ModelToolResult } from "@loongcode/model"
import { estimateTokens } from "./budget"
import type { ToolAffordances } from "../tools/types"

/**
 * Namespaced discriminator for a pruning marker.
 *
 * Namespacing is what makes collision avoidance independent of which tools
 * happen to exist today: a future tool that legitimately emits
 * `{ pruned: true }` as genuine `json` output cannot be misread as a marker.
 */
const PRUNED_KEY = "loongcodePruned"

/** The only reason a result is reduced: the request does not fit its budget. */
export type PruneReason = "request-over-budget"

/** A `ToolMessage` plus Agent-local metadata that never reaches the provider. */
export type ProjectionMessage = ModelMessage & {
  readonly failureEvidence?: boolean
  /**
   * Declared by whichever layer capped a result — see `ToolAffordances`.
   * Keyed by `toolCallId`, because the metadata describes one execution: a
   * turn's results must each be reduced with their own recovery, never a
   * sibling's.
   */
  readonly affordances?: Readonly<Record<string, ToolAffordances>>
}

/** What one pruning pass actually removed. */
export interface PruneStats {
  /**
   * Distinct tool outputs replaced by a pruned marker. A result the two-stage
   * shrink rewrites more than once is still one reduction.
   */
  readonly reduced: number
  /** Combined original UTF-8 byte length of exactly those results. */
  readonly originalBytes: number
}

/** Inputs needed to decide whether — and how far — to reduce a request. */
export interface PruneContext {
  /**
   * Provider-reported input tokens for the *previous* request. A trigger
   * signal only: it measures a request already sent, so it can never be
   * reduced by changing the current projection.
   */
  readonly lastInputTokens?: number
  /** Tokens available for input, from `contextBudget()`. The hard boundary. */
  readonly inputBudget: number
  /**
   * Observability sink, called once for a pass that reduced something.
   *
   * Not called when nothing was reduced — absence means this pass withheld
   * nothing, so a caller never has to filter out a zero-valued observation.
   * A throwing sink is ignored: reporting must not change what pruning does.
   */
  readonly onPrune?: (stats: PruneStats) => void
}

/**
 * The model-facing stand-in for tool output withheld from a request.
 *
 * Deliberately a structured object rather than a sentence of text: a `text`
 * output is wire-indistinguishable from a genuine tool result (see
 * `toSDKToolOutput`, which maps `text` straight to the SDK's `text` kind), so
 * no wording could tell the model this is a placeholder rather than content.
 * `json` is an existing `ModelToolOutput` variant that already has a wire
 * representation, and the marker carries no recovery *instruction* — it states
 * facts only.
 */
export interface PrunedToolOutput {
  readonly [PRUNED_KEY]: true
  readonly reason: PruneReason
  readonly toolName: string
  readonly originalBytes: number
  /**
   * Recovery affordances carried over verbatim from the output being
   * replaced, so request-time reduction never destroys a way back to the
   * content.
   *
   * They arrive structurally: the capping layer declares a `ToolAffordances`
   * on the tool result, `ToolMessage` carries it, and this projection reads it
   * off the message. Nothing here inspects the result's prose, so a tool is
   * free to reword its visible message without breaking recovery.
   */
  readonly spillPath?: string
  readonly resumeOffset?: number
  /** Present when part of the content was retained rather than withheld. */
  readonly excerpt?: string
}

/** True when `output` is a pruning marker rather than real tool content. */
export function isPrunedToolOutput(
  output: ModelToolOutput,
): output is { readonly type: "json"; readonly value: PrunedToolOutput } {
  if (output.type !== "json") return false
  const value = output.value
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)[PRUNED_KEY] === true
}

/**
 * The marker that replaces a withheld result.
 *
 * Recovery affordances come from the result's declared metadata, never from
 * its prose. This module used to regex-match the sentences emitted by
 * `tools/truncate.ts` and `read` ("Full content saved to: …", "Use offset=N to
 * continue."), which meant rewording a tool's user-facing message silently
 * removed the model's way back to the content. The producer now declares the
 * fact structurally and this layer consumes it; no wording is load-bearing.
 */
function markerFor(
  result: ModelToolResult,
  affordances: ToolAffordances | undefined,
  excerpt: string | undefined,
  originalBytes: number,
): ModelToolResult {
  return {
    ...result,
    output: {
      type: "json",
      value: {
        [PRUNED_KEY]: true,
        reason: "request-over-budget",
        toolName: result.toolName,
        originalBytes,
        ...(affordances?.externalizedAt === undefined ? {} : { spillPath: affordances.externalizedAt }),
        ...(affordances?.resumeOffset === undefined ? {} : { resumeOffset: affordances.resumeOffset }),
        ...(excerpt === undefined ? {} : { excerpt }),
      },
    },
  }
}

/** Index of the last user message, or -1 when there is none. */
function lastUserIndexOf(messages: readonly ProjectionMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i
  }
  return -1
}

/**
 * Whether this result may be withheld from the request. Failure evidence and
 * `tool_error` results are never withheld; only `text` output is reducible
 * (markers are `json`, so this is also what makes the projection idempotent).
 */
function isReducible(message: ProjectionMessage, result: ModelToolResult): boolean {
  if (message.failureEvidence === true) return false
  return result.output.type === "text"
}

function textOf(result: ModelToolResult): string {
  return result.output.type === "text" ? result.output.text : ""
}

/** Strips Agent-local metadata; the result is what the provider receives. */
function toModelMessages(messages: readonly ProjectionMessage[]): ModelMessage[] {
  return messages.map(({ role, content }) => ({ role, content }) as ModelMessage)
}

/**
 * Request-time context safety.
 *
 * Responsibilities (mechanism 2) — reduce an over-budget *request projection*
 * so the model call fits its input budget. This function never mutates durable
 * history, never runs on a turn-count rule, and never withholds failure
 * evidence. Emitting a smaller durable history is compaction's job.
 *
 * Trigger vs target: the decision to *enter* reduction uses
 * `max(lastInputTokens, estimateTokens(projection))`, because provider usage is
 * the more accurate signal when it is available. The reduction *target* is
 * `estimateTokens(projection) <= inputBudget` alone — `lastInputTokens`
 * describes a request already sent and cannot be reduced by rebuilding the
 * current one, so targeting it would over-reduce or never terminate.
 *
 * Reduction order:
 *   1. withhold the oldest reducible results, oldest first;
 *   2. if the newest result alone is still too large, keep it represented as a
 *      marker that carries an excerpt and its recovery affordances.
 *
 * Terminates when the projection fits or no reducible content remains.
 *
 * Omitting `context` means no budget is known, so no pressure can be shown and
 * the projection is returned unchanged.
 */
export function pruneOldToolOutputs(
  messages: readonly ProjectionMessage[],
  context?: PruneContext,
): ModelMessage[] {
  if (messages.length === 0) return toModelMessages(messages)
  if (context === undefined) return messages.map(({ role, content }) => ({ role, content }) as ModelMessage)

  const projection: ProjectionMessage[] = messages.map(message => ({ ...message }))
  const safety = Math.max(context.lastInputTokens ?? 0, estimateTokens(toModelMessages(projection)))
  if (safety <= context.inputBudget) return toModelMessages(projection)

  const fits = (): boolean => estimateTokens(toModelMessages(projection)) <= context.inputBudget
  const lastUserIndex = lastUserIndexOf(projection)

  // Observability accounting. A result the two-stage shrink rewrites more than
  // once is ONE reduction, so each distinct result is recorded on its first
  // replacement and its original size added exactly once.
  let reduced = 0
  let originalBytes = 0
  const recordReduction = (bytes: number): void => {
    reduced += 1
    originalBytes += bytes
  }

  // Stage 1 — withhold the oldest reducible results. Everything in the current
  // user turn is protected, as are failure-evidence turns and tool errors.
  for (let i = 0; i < projection.length && !fits(); i++) {
    if (i >= lastUserIndex && lastUserIndex !== -1) break
    const message = projection[i]
    if (message.role !== "tool") continue
    const count = (message.content as readonly ModelToolResult[]).length
    for (let r = 0; r < count; r++) {
      if (fits()) break
      // Re-read from the projection: an earlier iteration of this inner loop
      // may already have replaced a sibling result, and rebuilding from a
      // stale array would silently discard that reduction.
      const current = projection[i].content as readonly ModelToolResult[]
      const result = current[r]
      if (!isReducible(projection[i], result)) continue
      const text = textOf(result)
      const bytes = Buffer.byteLength(text, "utf-8")
      // This result's own recovery, not its siblings' — see `ToolMessage.affordances`.
      const affordances = projection[i].affordances?.[result.toolCallId]
      projection[i] = {
        ...projection[i],
        content: current.map((candidate, ri) =>
          ri === r ? markerFor(result, affordances, undefined, bytes) : candidate,
        ),
      } as ProjectionMessage
      recordReduction(bytes)
    }
  }

  // Stage 2 — the newest result alone still does not fit. Keep it represented
  // but shrink it, retaining an excerpt and any recovery affordance instead of
  // withholding it entirely.
  if (!fits()) {
    for (let i = projection.length - 1; i >= 0; i--) {
      const message = projection[i]
      if (message.role !== "tool") continue
      const content = message.content as readonly ModelToolResult[]
      for (let r = content.length - 1; r >= 0; r--) {
        const result = content[r]
        if (!isReducible(message, result)) continue
        const text = textOf(result)
        const bytes = Buffer.byteLength(text, "utf-8")
        // Derive the reduction from the estimator and the budget — never from
        // an arbitrary byte constant.
        const excessChars = Math.max(0, (estimateTokens(toModelMessages(projection)) - context.inputBudget) * 4)
        const keepChars = Math.max(0, text.length - excessChars)
        // This result may be rewritten twice below. It is still ONE reduced
        // result, so it is recorded on the first replacement only.
        let recorded = false
        const shrink = (excerpt: string | undefined): void => {
          projection[i] = {
            ...projection[i],
            content: content.map((candidate, ri) =>
              ri === r
                ? markerFor(result, projection[i].affordances?.[result.toolCallId], excerpt, bytes)
                : candidate),
          } as ProjectionMessage
          if (!recorded) {
            recorded = true
            recordReduction(bytes)
          }
        }
        shrink(keepChars > 0 ? text.slice(0, keepChars) : undefined)
        // The marker's own metadata costs tokens; drop the excerpt if that is
        // what it takes to fit. Deterministic, two steps, then stop.
        if (!fits() && keepChars > 0) shrink(undefined)
        break
      }
      break
    }
  }

  if (reduced > 0 && context.onPrune !== undefined) {
    try {
      context.onPrune({ reduced, originalBytes })
    } catch {
      // Best-effort reporting: a failing sink must not discard the projection
      // this pass already computed, nor change what the model receives.
    }
  }

  return toModelMessages(projection)
}
