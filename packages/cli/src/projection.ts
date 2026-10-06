import type { ModelLimits, ModelUsage } from "@minicode/model"
import { eastAsianWidth } from "get-east-asian-width"
import { contextBudget } from "@minicode/agent"
import type { RunEvent, RunFinishReason, RunSummary } from "@minicode/agent"

/**
 * Pure projections of runtime facts into display text.
 *
 * Nothing here derives a number the runtime did not already produce: usage,
 * counts and pruning come from a `RunSummary` or a `RunEvent`, and the context
 * reading is measured against the same `contextBudget()` the runtime acts on.
 * Kept free of the terminal so the semantics can be tested directly.
 *
 * The footer is two rows with distinct scopes (see `footerRows`): row 1 is
 * identity + state, row 2 is usage. The last completed request's context and the
 * run's cumulative totals are always separate, differently-labelled fields.
 */

// ---------------------------------------------------------------------------
// Run display — the runtime facts the footer folds forward
// ---------------------------------------------------------------------------

/** The runtime facts the footer reads, folding forward as a run proceeds. */
export interface RunDisplay {
  /** The most recent completed model call's usage, or undefined before one finishes. */
  readonly lastCallUsage: ModelUsage | undefined
  /** Cumulative usage of the current run, summed live from the event stream. */
  readonly runUsage: ModelUsage | undefined
  /** Model calls completed in the current (or last) run. */
  readonly runRequests: number
  /** The completed run record, once a run has ended. */
  readonly lastRun: RunSummary | undefined
  /** Messages summarized by the most recent compaction in the current run. */
  readonly compactedMessages: number | undefined
}

/** A run that has not started: no call, no cumulative usage, no record. */
export const NO_RUN_DISPLAY: RunDisplay = {
  lastCallUsage: undefined,
  runUsage: undefined,
  runRequests: 0,
  lastRun: undefined,
  compactedMessages: undefined,
}

/** Every token field of `ModelUsage`, so a field added later is summed too. */
const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof ModelUsage)[]

/** Adds one call's usage into a running total. Subset fields stay subsets. */
function addUsage(total: ModelUsage | undefined, call: ModelUsage | undefined): ModelUsage | undefined {
  if (call === undefined) return total
  const summed: Record<string, number> = { ...(total ?? {}) }
  for (const key of USAGE_KEYS) {
    const value = call[key]
    if (value === undefined) continue
    summed[key] = (summed[key] ?? 0) + value
  }
  return summed as ModelUsage
}

/**
 * Folds one run event into the display state.
 *
 * Narrow and pure. A new run resets everything; `model_response` advances the
 * last-call reading and the live run totals; `compaction` adds the
 * summarization call's usage and records the message count; `run_end` replaces
 * the live totals with the authoritative run record and clears the transient
 * compaction note. The `run_start`/`run_end` distinction is what keeps
 * "this run" and "last run" from sharing a field.
 */
export function reduceRunDisplay(state: RunDisplay, event: RunEvent): RunDisplay {
  switch (event.type) {
    case "run_start":
      return NO_RUN_DISPLAY
    case "model_response":
      // The request count mirrors the runtime: every model_response is one call.
      return {
        ...state,
        lastCallUsage: event.usage ?? state.lastCallUsage,
        runRequests: state.runRequests + 1,
        runUsage: addUsage(state.runUsage, event.usage),
      }
    case "compaction":
      // A compaction's summarization call never emits `model_response`; its cost
      // is summed here so the live run total cannot miss it.
      return {
        ...state,
        runUsage: addUsage(state.runUsage, event.usage),
        compactedMessages: event.summarizedMessages,
      }
    case "run_end":
      return {
        ...state,
        lastRun: event.run,
        runUsage: event.run.usage ?? state.runUsage,
        runRequests: event.run.modelCalls ?? state.runRequests,
        compactedMessages: undefined,
      }
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Footer — two semantic rows
// ---------------------------------------------------------------------------

/** How a footer part should read; the renderer applies color. */
export type FooterTone = "dim" | "warn" | "ok" | "alert"

/**
 * One piece of footer text.
 *
 * `drop` is the drop priority under width pressure: 0 means never drop; higher
 * drops first. `truncatable` marks a part that is shortened rather than dropped
 * (the workspace path).
 */
export interface FooterPart {
  readonly text: string
  readonly tone: FooterTone
  readonly drop: number
  readonly truncatable?: boolean
}

/** Parts within a group are joined by a space. */
export interface FooterGroup {
  readonly parts: readonly FooterPart[]
}

/** Groups within a row are joined by ` · `. */
export interface FooterRow {
  readonly groups: readonly FooterGroup[]
}

/** The two footer rows, in order. */
export interface FooterLines {
  readonly row1: FooterRow
  readonly row2: FooterRow
}

/** Everything the footer renders. */
export interface FooterInput {
  /** Session working directory. */
  readonly cwd: string
  /** Git branch, when the workspace is a repository. */
  readonly branch: string | undefined
  readonly running: boolean
  /** Active model configuration key, when a model is resolved. */
  readonly modelId: string | undefined
  /** Limits of the model in use, when one is resolved. */
  readonly limits: ModelLimits | undefined
  /** Share of the input budget at which proactive compaction begins. */
  readonly compactThresholdPct: number | undefined
  /** The most recent completed model call's usage, if any call has finished. */
  readonly lastCallUsage: ModelUsage | undefined
  /** Model calls completed in the current (or last) run. */
  readonly runRequests: number
  /** Cumulative usage of the current (or last) run. */
  readonly runUsage: ModelUsage | undefined
  /** The completed run record, once a run has ended. */
  readonly lastRun: RunSummary | undefined
  /** Messages summarized by the most recent runtime compaction in this run. */
  readonly compactedMessages: number | undefined
}

/** How a model call stands against the runtime's usable input budget. */
export interface ContextDisplay {
  /** Last completed request's input tokens. */
  readonly used: number
  /** MiniCode's usable input budget: `floor(contextWindow × 0.75)`. */
  readonly capacity: number
  /** `used / capacity` as a whole percent; may exceed 100. */
  readonly percent: number
  /** `used / capacity`, unclamped — the gauge clamps this, the number does not. */
  readonly frac: number
  /** The request consumed more than the budget. */
  readonly overBudget: boolean
  /** At or above the configured compaction threshold, but within budget. */
  readonly atThreshold: boolean
}

/**
 * Context pressure for one model call, measured against the runtime's own input
 * budget rather than the raw context window.
 *
 * The denominator is the budget the runtime compacts against (and the same
 * budget the provider's `inputTokens` is compared to), so the reading and the
 * threshold share one scale. The numerator lags one request: it is the last
 * *completed* call, which is also the value the runtime's compaction trigger
 * reads.
 */
export function contextDisplay(
  usedInput: number | undefined,
  limits: ModelLimits | undefined,
  thresholdPct: number | undefined,
): ContextDisplay | undefined {
  if (usedInput === undefined || limits === undefined || thresholdPct === undefined) return undefined
  const capacity = contextBudget(limits).inputBudget
  if (capacity <= 0) return undefined
  const used = Math.max(0, usedInput)
  const frac = used / capacity
  const threshold = Math.floor(capacity * (thresholdPct / 100))
  return {
    used,
    capacity,
    percent: Math.round(frac * 100),
    frac,
    overBudget: used > capacity,
    atThreshold: used >= threshold && used <= capacity,
  }
}

const GAUGE_CELLS = 12

/** A fixed-width context gauge; the fill is clamped to the box at all values. */
export function contextGauge(frac: number): string {
  const clamped = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0
  const filled = Math.round(clamped * GAUGE_CELLS)
  return `[${"█".repeat(filled)}${"░".repeat(GAUGE_CELLS - filled)}]`
}

function trimZero(value: string): string {
  return value.replace(/\.0$/, "")
}

/** A token count abridged for the footer: `900`, `1.2k`, `96k`, `1M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`
  if (n >= 1_000) return `${trimZero((n / 1_000).toFixed(1))}k`
  return `${Math.round(n)}`
}

/** Visible width of plain (uncolored) text, treating wide glyphs as two cells. */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    width += cp === undefined ? 0 : eastAsianWidth(cp)
  }
  return width
}

/** Truncate plain text to a visible width, never splitting a wide glyph. */
export function truncatePlain(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let out = ""
  let w = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    const cw = cp === undefined ? 0 : eastAsianWidth(cp)
    if (w + cw > width) break
    out += ch
    w += cw
  }
  return out
}

function shortenCwd(cwd: string): string {
  return cwd.replace(/^\/home\/[^/]+/, "~").replace(/\/+$/, "") || "/"
}

const MODEL_ID_MAX = 16

function truncateModelId(id: string): string {
  return id.length > MODEL_ID_MAX ? `${id.slice(0, MODEL_ID_MAX - 1)}…` : id
}

function runTokensText(usage: ModelUsage | undefined): string | undefined {
  if (usage === undefined) return undefined
  const parts: string[] = []
  if (usage.inputTokens !== undefined) parts.push(`${formatTokens(usage.inputTokens)} in`)
  if (usage.outputTokens !== undefined) parts.push(`${formatTokens(usage.outputTokens)} out`)
  return parts.length === 0 ? undefined : parts.join(" / ")
}

/** Wall-clock time the run spanned, when the runtime recorded both ends. */
function elapsedMs(run: RunSummary): number | undefined {
  if (run.startedAt === undefined || run.finishedAt === undefined) return undefined
  const span = run.finishedAt - run.startedAt
  // A negative span can only come from the clock moving, not from the run.
  return span < 0 ? undefined : span
}

/** Footer durations drop a trailing `.0` (`18s`, `1.2m`); the transcript keeps it. */
function formatElapsed(ms: number): string {
  return formatDuration(ms).replace(/\.0([sm])$/, "$1")
}

/** How the last run ended, in words, with its duration where recorded. */
function lastRunText(run: RunSummary): string {
  const elapsed = elapsedMs(run)
  switch (run.finishReason) {
    case "stop":
      return elapsed === undefined ? "finished" : `finished in ${formatElapsed(elapsed)}`
    case "aborted":
      return elapsed === undefined ? "interrupted" : `interrupted after ${formatElapsed(elapsed)}`
    case "error":
      return "ended in error"
    case undefined:
      return "did not finish"
    default:
      return `ended without a final answer (${run.finishReason})`
  }
}

/**
 * Row 1 — identity, state, control, model.
 *
 * The workspace path is the only truncatable field; state, interrupt,
 * branch, and (after the window) the model id are never dropped.
 */
function footerRow1(input: FooterInput): FooterRow {
  const groups: FooterGroup[] = []

  const cwdParts: FooterPart[] = [
    { text: shortenCwd(input.cwd), tone: "dim", drop: 3, truncatable: true },
  ]
  if (input.branch !== undefined && input.branch.length > 0) {
    cwdParts.push({ text: `(${input.branch})`, tone: "dim", drop: 0 })
  }
  groups.push({ parts: cwdParts })

  groups.push({
    parts: [{ text: input.running ? "Working" : "Idle", tone: input.running ? "warn" : "ok", drop: 0 }],
  })

  if (input.running) {
    groups.push({ parts: [{ text: "Esc to interrupt", tone: "dim", drop: 0 }] })
  }

  if (input.modelId !== undefined && input.limits !== undefined) {
    groups.push({ parts: [{ text: truncateModelId(input.modelId), tone: "dim", drop: 1 }] })
    groups.push({ parts: [{ text: `${formatTokens(input.limits.contextWindow)} window`, tone: "dim", drop: 2 }] })
  }

  return { groups }
}

/**
 * Row 2 — usage: context (this request) then run totals (cumulative).
 *
 * The context denominator is always MiniCode's usable input budget; the model's
 * total window is shown only in row 1. Above budget the gauge saturates, the
 * number stays truthful, and the percent is not shown as if it were ordinary.
 */
function footerRow2(input: FooterInput): FooterRow {
  const groups: FooterGroup[] = []
  const context = contextDisplay(input.lastCallUsage?.inputTokens, input.limits, input.compactThresholdPct)

  if (input.limits !== undefined) {
    if (context === undefined) {
      groups.push({
        parts: [
          { text: "Context", tone: "dim", drop: 0 },
          { text: "—", tone: "dim", drop: 0 },
        ],
      })
    } else {
      const tone: FooterTone = context.overBudget ? "alert" : context.atThreshold ? "warn" : "dim"
      const parts: FooterPart[] = [
        { text: "Context", tone, drop: 0 },
        { text: contextGauge(context.frac), tone, drop: 1 },
        { text: `${formatTokens(context.used)}/${formatTokens(context.capacity)}`, tone, drop: 0 },
      ]
      if (context.overBudget) {
        parts.push({ text: "over budget", tone: "alert", drop: 0 })
      } else {
        parts.push({ text: "usable", tone, drop: 2 })
      }
      groups.push({ parts })

      if (context.overBudget) {
        // Over budget is beyond the compaction threshold, so the runtime is
        // compacting (or has failed and will report an overflow error).
        if (input.running) groups.push({ parts: [{ text: "compacting…", tone: "warn", drop: 0 }] })
      } else if (input.compactedMessages !== undefined) {
        const messages = input.compactedMessages === 1 ? "message" : "messages"
        groups.push({
          parts: [{ text: `compacted ${input.compactedMessages} ${messages}`, tone: "dim", drop: 3 }],
        })
      } else if (input.compactThresholdPct !== undefined) {
        groups.push({ parts: [{ text: `auto-compact at ${input.compactThresholdPct}%`, tone: "dim", drop: 3 }] })
      }
    }
  }

  const runTokens = runTokensText(input.runUsage)
  if (input.running) {
    if (input.runRequests > 0) {
      groups.push({ parts: [{ text: `run ${input.runRequests} req`, tone: "dim", drop: 5 }] })
    } else {
      groups.push({ parts: [{ text: "waiting for first response", tone: "dim", drop: 4 }] })
    }
    if (runTokens !== undefined) groups.push({ parts: [{ text: runTokens, tone: "dim", drop: 4 }] })
  } else if (input.lastRun !== undefined) {
    groups.push({ parts: [{ text: `last run ${lastRunText(input.lastRun)}`, tone: "dim", drop: 3 }] })
    if (input.runRequests > 0) {
      groups.push({ parts: [{ text: `${input.runRequests} req`, tone: "dim", drop: 5 }] })
    }
    if (runTokens !== undefined) groups.push({ parts: [{ text: runTokens, tone: "dim", drop: 4 }] })
  } else {
    groups.push({ parts: [{ text: "no run yet", tone: "dim", drop: 4 }] })
  }

  return { groups }
}

/** The footer's two rows, in order. */
export function footerRows(input: FooterInput): FooterLines {
  return { row1: footerRow1(input), row2: footerRow2(input) }
}

// ---------------------------------------------------------------------------
// Width-aware fitting (pure; the renderer only paints tones)
// ---------------------------------------------------------------------------

function groupWidth(group: FooterGroup): number {
  const textWidth = group.parts.reduce((w, p) => w + displayWidth(p.text), 0)
  return textWidth + Math.max(0, group.parts.length - 1)
}

function rowWidth(groups: readonly FooterGroup[]): number {
  const inner = groups.reduce((w, g) => w + groupWidth(g), 0)
  return inner + Math.max(0, groups.length - 1) * displayWidth(" · ")
}

function cloneGroups(groups: readonly FooterGroup[]): Array<{ parts: FooterPart[] }> {
  return groups.map(g => ({ parts: g.parts.map(p => ({ ...p })) }))
}

/** Shorten every truncatable part (the path) until the row fits or it cannot. */
function shrinkTruncatables(groups: Array<{ parts: FooterPart[] }>, width: number): void {
  for (const group of groups) {
    for (const part of group.parts) {
      if (part.truncatable !== true) continue
      const original = part.text
      for (let keep = original.length - 1; keep >= 1; keep--) {
        if (rowWidth(groups) <= width) return
        ;(part as { text: string }).text = `…${original.slice(original.length - keep)}`
      }
      ;(part as { text: string }).text = "…"
    }
  }
}

/** Index of the highest-priority droppable part, or undefined when none remains. */
function highestDroppablePart(
  groups: readonly { parts: readonly FooterPart[] }[],
): { group: number; part: number } | undefined {
  let best: { group: number; part: number } | undefined
  let bestDrop = 0
  groups.forEach((group, gi) => {
    group.parts.forEach((p, pi) => {
      if (p.drop <= bestDrop || p.truncatable === true) return
      best = { group: gi, part: pi }
      bestDrop = p.drop
    })
  })
  return best
}

/**
 * Fit a row to a visible width by the contract's deterministic rules:
 * truncate the path first, then drop fields in priority order (run requests,
 * run tokens, the compaction rule, `usable`, the gauge). State, interrupt,
 * model, and the context number are never dropped.
 */
export function fitFooterRow(row: FooterRow, width: number): FooterRow {
  if (width <= 0) return { groups: [] }
  let groups = cloneGroups(row.groups)
  if (rowWidth(groups) <= width) return { groups }

  shrinkTruncatables(groups, width)
  if (rowWidth(groups) <= width) return { groups }

  while (rowWidth(groups) > width) {
    const pick = highestDroppablePart(groups)
    if (pick === undefined) break
    const group = groups[pick.group]!
    group.parts.splice(pick.part, 1)
    if (group.parts.length === 0) groups.splice(pick.group, 1)
  }

  if (rowWidth(groups) <= width) return { groups }
  shrinkTruncatables(groups, width)
  return { groups }
}

/** A row as plain text (no color), groups joined by ` · ` and parts by a space. */
export function footerRowText(row: FooterRow): string {
  return row.groups.map(g => g.parts.map(p => p.text).join(" ")).join(" · ")
}

// ---------------------------------------------------------------------------
// Run summary (transcript) and final JSON line — unchanged semantics
// ---------------------------------------------------------------------------

/** `↑in ↓out`, omitting whichever side the provider did not report. */
function arrowPair(usage: ModelUsage): string | undefined {
  const parts: string[] = []
  if (usage.inputTokens !== undefined) parts.push(`↑${usage.inputTokens}`)
  if (usage.outputTokens !== undefined) parts.push(`↓${usage.outputTokens}`)
  return parts.length === 0 ? undefined : parts.join(" ")
}

/** The compaction line, carrying the call's cost when the runtime reported it. */
export function compactionNoticeText(
  summarizedMessages: number,
  usage: ModelUsage | undefined,
): string {
  const base = `context compacted — ${summarizedMessages} messages summarized`
  if (usage === undefined) return base
  const cost = arrowPair(usage)
  return cost === undefined ? base : `${base} · ${cost}`
}

/** `1 model call`, `2 model calls` — a count read as prose. */
function count(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`
}

/**
 * How a run ended, in words rather than a runtime enum value.
 *
 * The markers say only which kind of ending this was. None of them is a tick:
 * a run that stops has produced a final answer, which is not the same as the
 * coding task having succeeded, and this line must not imply the latter.
 */
function runStateText(finishReason: RunFinishReason): string {
  switch (finishReason) {
    case "stop":
      return "● finished"
    case "aborted":
      return "■ interrupted"
    case "error":
      return "▲ ended in error"
    default:
      return `▲ ended without a final answer (${finishReason})`
  }
}

/**
 * How the run ended and how long it took, or undefined while it has not ended.
 *
 * A statement about the *run*, never about whether the coding work succeeded:
 * `stop` means the model produced a final answer, nothing more. A run whose
 * end is not known reports no duration rather than a fabricated one.
 */
export function runStateLine(run: RunSummary): string | undefined {
  if (run.finishReason === undefined) return undefined
  const elapsed = elapsedMs(run)
  const took = elapsed === undefined ? "" : ` · ${formatDuration(elapsed)}`
  return `${runStateText(run.finishReason)}${took}`
}

/** A compact summary of a finished run, read from the record as given. */
export function runSummaryLines(run: RunSummary): string[] {
  const lines: string[] = []

  const state = runStateLine(run)
  if (state !== undefined) lines.push(state)

  const counts: string[] = []
  if (run.modelCalls !== undefined) counts.push(count(run.modelCalls, "model call"))
  if (run.toolCalls !== undefined) counts.push(count(run.toolCalls, "tool call"))
  if (counts.length > 0) lines.push(counts.join(" · "))

  if (run.usage !== undefined) {
    // Labelled as run totals, so they cannot be read as the last call's.
    const tokens: string[] = []
    if (run.usage.inputTokens !== undefined) tokens.push(`↑${run.usage.inputTokens} input`)
    if (run.usage.outputTokens !== undefined) tokens.push(`↓${run.usage.outputTokens} output`)
    if (tokens.length > 0) lines.push(tokens.join(" · "))
  }

  // Only when something was actually withheld: absence of the indicator is
  // how a run that never pruned is shown.
  if (run.pruning !== undefined && run.pruning.reduced > 0) {
    const results = run.pruning.reduced === 1 ? "result" : "results"
    lines.push(`pruned ${run.pruning.reduced} tool ${results} (${formatBytes(run.pruning.originalBytes)})`)
  }

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
