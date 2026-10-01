import type { ModelLimits, ModelUsage } from "@minicode/model"
import { contextBudget } from "../context-budget"
import type { RunEvent, RunFinishReason, RunSummary } from "../session/types"

/**
 * Pure projections of runtime facts into display text.
 *
 * Nothing here derives a number the runtime did not already produce: usage,
 * counts and pruning come from a `RunSummary` or a `RunEvent`, and the context
 * reading is measured against the same `contextBudget()` the runtime acts on.
 * Kept free of the terminal so the semantics can be tested directly.
 */

/** The runtime facts the footer reads, folding forward as a run proceeds. */
export interface RunDisplay {
  /** The runtime's loop-slot counter. It can repeat; it is not a call count. */
  readonly step: number
  /** The most recent completed model call, or undefined before one finishes. */
  readonly lastCallUsage: ModelUsage | undefined
  /** Cumulative usage of the run, once the run has ended. */
  readonly runUsage: ModelUsage | undefined
}

/** A run that has not started: no step, no call, no cumulative usage. */
export const NO_RUN_DISPLAY: RunDisplay = {
  step: 0,
  lastCallUsage: undefined,
  runUsage: undefined,
}

/**
 * Folds one run event into the display state.
 *
 * Narrow and pure so the distinction the footer depends on — the last call's
 * usage is never the run's, and the run's never becomes the last call's — is
 * testable without a terminal. Events carrying no display fact leave the
 * state untouched.
 */
export function reduceRunDisplay(state: RunDisplay, event: RunEvent): RunDisplay {
  switch (event.type) {
    case "run_start":
      // A new run has no cumulative usage of its own, and the previous run's
      // last call says nothing about this one.
      return NO_RUN_DISPLAY
    case "iteration_start":
      return { ...state, step: event.iteration }
    case "model_response":
      return event.usage === undefined ? state : { ...state, lastCallUsage: event.usage }
    case "run_end":
      // The run's totals arrive here, and touch the last-call reading not at all.
      return { ...state, runUsage: event.run.usage }
    default:
      return state
  }
}

/** How a footer segment should read; the caller applies color. */
export type FooterTone = "dim" | "warn" | "ok"

export interface FooterSegment {
  readonly text: string
  readonly tone: FooterTone
}

/** Everything the footer renders. */
export interface FooterInput {
  readonly cwd: string
  readonly branch: string | undefined
  /** The most recent completed model call's usage, if any call has finished. */
  readonly lastCallUsage: ModelUsage | undefined
  /** Cumulative usage for the run just finished, if a run has finished. */
  readonly runUsage: ModelUsage | undefined
  /** Limits of the model in use, if one has been resolved. */
  readonly limits: ModelLimits | undefined
  /** Share of the input budget at which proactive compaction begins. */
  readonly compactThresholdPct: number | undefined
  readonly running: boolean
  /** The runtime's loop-slot counter — deliberately not a model-call count. */
  readonly step: number
}

/** Where a model call stands against the runtime's input budget. */
export interface ContextReading {
  /** Percent of the input budget that call's prompt consumed. */
  readonly percent: number
  /** Percent of the same budget at which compaction begins. */
  readonly compactAtPercent: number
}

/**
 * Context pressure for one model call, measured against the runtime's own
 * input budget rather than the raw context window.
 *
 * The denominator is the budget the runtime compacts against, so the reading
 * and the threshold share one scale: compaction begins at `compactAtPercent`.
 * That percentage is the configured threshold itself, not a recomputation of
 * it, so the two cannot drift apart.
 */
export function contextReading(
  lastCallInput: number | undefined,
  limits: ModelLimits | undefined,
  compactThresholdPct: number | undefined,
): ContextReading | undefined {
  if (lastCallInput === undefined || limits === undefined || compactThresholdPct === undefined) {
    return undefined
  }
  const { inputBudget } = contextBudget(limits)
  if (inputBudget <= 0) return undefined
  return {
    percent: Math.round((lastCallInput / inputBudget) * 100),
    compactAtPercent: compactThresholdPct,
  }
}

/** `↑in ↓out`, omitting whichever side the provider did not report. */
function tokenPair(usage: ModelUsage): string | undefined {
  const parts: string[] = []
  if (usage.inputTokens !== undefined) parts.push(`↑${usage.inputTokens}`)
  if (usage.outputTokens !== undefined) parts.push(`↓${usage.outputTokens}`)
  return parts.length === 0 ? undefined : parts.join(" ")
}

/**
 * The footer's segments, in order.
 *
 * The last call's consumption and the run's cumulative consumption are always
 * distinct segments with distinct labels, so neither changes meaning when a
 * run ends.
 */
export function footerSegments(input: FooterInput): FooterSegment[] {
  const cwdShort = input.cwd.replace(/^\/home\/[^/]+/, "~").replace(/\/+$/, "") || "/"
  const branch = input.branch === undefined ? "" : ` (${input.branch})`
  const segments: FooterSegment[] = [{ text: `${cwdShort}${branch}`, tone: "dim" }]

  if (input.lastCallUsage !== undefined) {
    const call = tokenPair(input.lastCallUsage)
    if (call !== undefined) segments.push({ text: call, tone: "dim" })

    const reading = contextReading(
      input.lastCallUsage.inputTokens,
      input.limits,
      input.compactThresholdPct,
    )
    if (reading !== undefined) {
      segments.push({
        text: `ctx ${reading.percent}% · compact ${reading.compactAtPercent}%`,
        tone: "dim",
      })
    }
  }

  if (input.runUsage !== undefined) {
    const run = tokenPair(input.runUsage)
    if (run !== undefined) segments.push({ text: `run ${run}`, tone: "dim" })
  }

  segments.push(
    input.running
      ? { text: `working (step ${input.step}) — esc to interrupt`, tone: "warn" }
      : { text: "idle", tone: "ok" },
  )
  return segments
}

/** The compaction line, carrying the call's cost when the runtime reported it. */
export function compactionNoticeText(
  summarizedMessages: number,
  usage: ModelUsage | undefined,
): string {
  const base = `context compacted — ${summarizedMessages} messages summarized`
  if (usage === undefined) return base
  const cost = tokenPair(usage)
  return cost === undefined ? base : `${base} · ${cost}`
}

/** What a finished run should say, if anything, beyond its summary. */
export type RunEndNotice =
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "warn"; readonly text: string }

/**
 * The notice a run's terminal state warrants.
 *
 * A reason of `stop` is the model's own final answer, and `aborted` is a user
 * interruption — both are expected, so neither is flagged. Everything else is
 * surfaced so the run does not look like it simply stopped. This is a fact
 * about how the loop ended, never a claim about the coding task.
 */
export function runEndNotice(
  finishReason: RunFinishReason,
  error: string | undefined,
): RunEndNotice | undefined {
  if (error !== undefined) return { kind: "error", text: error }
  if (finishReason === "stop" || finishReason === "aborted") return undefined
  return { kind: "warn", text: `run ended without a final answer (${finishReason})` }
}

/** A compact, plain-text summary of a finished run, read from the record. */
export function runSummaryLines(run: RunSummary): string[] {
  const lines: string[] = []

  const counts: string[] = []
  if (run.modelCalls !== undefined) counts.push(`${run.modelCalls} model calls`)
  if (run.toolCalls !== undefined) counts.push(`${run.toolCalls} tool calls`)
  if (counts.length > 0) lines.push(counts.join(" · "))

  if (run.usage !== undefined) {
    const tokens = tokenPair(run.usage)
    if (tokens !== undefined) lines.push(`tokens ${tokens}`)
  }

  // Only when something was actually withheld: absence of the indicator is
  // how a run that never pruned is shown.
  if (run.pruning !== undefined && run.pruning.reduced > 0) {
    const results = run.pruning.reduced === 1 ? "result" : "results"
    lines.push(`pruned ${run.pruning.reduced} tool ${results} (${formatBytes(run.pruning.originalBytes)})`)
  }

  if (run.finishReason !== undefined) lines.push(`finish ${run.finishReason}`)
  return lines
}

/** The final line of `--mode json`: the existing fields, plus the run record. */
export function resultLine(
  finishReason: RunFinishReason,
  iterations: number,
  error: string | undefined,
  run: RunSummary | undefined,
): Record<string, unknown> {
  return {
    type: "result",
    finishReason,
    iterations,
    error: error ?? null,
    ...(run === undefined ? {} : { runId: run.id, run }),
  }
}

/** A short human duration. Milliseconds below a second, seconds below a minute. */
export function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${ms}ms`
}

/** Byte counts at the scale pruning reaches: KB, then MB. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)}KB`
  return `${bytes}B`
}
