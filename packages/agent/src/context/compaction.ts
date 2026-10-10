import type { Model, ModelMessage, ModelUsage } from "@loongcode/model"
import { contextBudget, estimateTokens } from "./budget"
import type { Session } from "../session/session"
import type { SessionMessage } from "../session/types"

const PRESERVE_MIN_TOKENS = 2000
const PRESERVE_MAX_TOKENS = 8000
const PRESERVE_BUDGET_RATIO = 0.25

const SUMMARY_PROMPT = `Summarize the conversation above. Include:
- The user's goal
- Key decisions made and why
- Work completed so far
- Current in-progress state
- Next steps

Be concise. Keep exact file paths, commands, and identifiers.`

/** Appended when older history had to be dropped to fit the summary request. */
const ELISION_NOTICE = `Note: earlier messages were omitted before this point because they exceeded the summarization input limit. Summarize only what is shown above and do not claim to cover the omitted portion.`

/**
 * The result of one compaction attempt.
 *
 * `no-progress` and `failed` are deliberately distinct: the first means the
 * history holds nothing summarizable, the second means the summarization call
 * itself did not succeed. Collapsing them (as a numeric `0` did) makes a real
 * failure indistinguishable from a healthy no-op in the run's error report.
 */
export type CompactionOutcome =
  | {
      readonly status: "compacted"
      readonly removed: number
      /** What the summarization call itself consumed, when the provider
       *  reported it. Absent on paths where no model call happened. */
      readonly usage?: ModelUsage
    }
  | {
      readonly status: "no-progress"
      readonly reason: "no-compactable-region" | "empty-tail" | "empty-summary"
    }
  | { readonly status: "failed"; readonly error: string }

/**
 * Reactive context management (mechanism 3):
 *
 * - `isOverflow`: the last model call's reported input usage reached the
 *   75% input budget — the next call cannot fit, so compact now.
 * - `compact`: LLM-summarize the older turns (all but a preserved recent
 *   tail) into a single user message and splice it into history.
 *
 * The summarization request is bounded by the same `contextBudget()` that
 * defines every other budget: recovery must not be able to fail for the same
 * reason that triggered it.
 */
/**
 * Summarizes a caller-supplied set of messages with `SUMMARY_PROMPT`.
 *
 * Shares the prompt and the shape the automatic compactor uses, so a
 * `/rewind` summary is indistinguishable downstream from a compaction
 * summary. `//rewind` chooses the range; this only produces the text.
 */
export async function summarizeMessages(
  model: Model,
  messages: readonly ModelMessage[],
  contextWindow?: number,
): Promise<string> {
  if (messages.length === 0) return ""
  const budget = contextWindow === undefined
    ? Number.POSITIVE_INFINITY
    : contextBudget({ contextWindow, maxOutputTokens: contextWindow }).inputBudget
  // Drop the oldest until the request fits, and say so, so the model is never
  // handed a partial history presented as complete.
  let start = 0
  const cost = (from: number): number =>
    estimateTokens([...messages.slice(from), { role: "user", content: SUMMARY_PROMPT }])
  while (start < messages.length - 1 && cost(start) > budget) start++
  const elided = start > 0
  const result = await model.generate({
    messages: [
      ...messages.slice(start),
      { role: "user", content: elided ? `${SUMMARY_PROMPT}\n\n${ELISION_NOTICE}` : SUMMARY_PROMPT },
    ] as ModelMessage[],
    temperature: 0,
  })
  return result.content ?? ""
}

export class Compactor {
  constructor(
    private readonly model: Model,
    private readonly contextWindow: number | undefined,
  ) {}

  isOverflow(usage: ModelUsage | undefined): boolean {
    if (this.contextWindow === undefined) return false
    if (usage === undefined || usage.inputTokens === undefined) return false
    return usage.inputTokens >= this.budgets().inputBudget
  }

  /** Rewrites history around an LLM summary. Never throws — every failure is
   *  reported through {@link CompactionOutcome} instead of a bare `0`. */
  async compact(session: Session): Promise<CompactionOutcome> {
    // The summarization call is a model request, so it passes the same
    // boundary as every other request: reconcile interruptible execution
    // state first, so the summary request never carries an unresolved tool
    // call. `recover` is idempotent and a no-op when there is nothing to
    // reconcile, so this is safe for in-loop compaction too (where the run
    // already reconciled before its requests).
    await session.recover()

    const messages = session.messages
    // The compactable region is everything UP TO AND INCLUDING the last
    // user message; the trailing in-progress turn (assistant/tool messages
    // after it) is never compacted — the model needs it to continue.
    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0 || lastUserIdx === messages.length - 1) {
      return { status: "no-progress", reason: "no-compactable-region" }
    }

    const compactable = messages.slice(0, lastUserIdx + 1)
    const preserved = selectPreservedTail(compactable, this.preserveBudgetTokens())
    if (preserved <= 0) return { status: "no-progress", reason: "empty-tail" }

    const older = compactable.slice(0, preserved)
    if (older.length === 0) return { status: "no-progress", reason: "empty-tail" }

    const { messages: summarized, elided } = this.boundSummaryInput(older)
    const summaryMessages: ModelMessage[] = [
      ...summarized.map(m => ({ role: m.role, content: m.content }) as ModelMessage),
      { role: "user", content: elided ? `${SUMMARY_PROMPT}\n\n${ELISION_NOTICE}` : SUMMARY_PROMPT },
    ]

    let summary: string
    let usage: ModelUsage | undefined
    try {
      const result = await this.model.generate({
        messages: summaryMessages,
        temperature: 0,
        // Explicit output headroom: the summary must fit the response budget,
        // not the provider's default cap.
        maxOutputTokens: this.budgets().outputBudget,
      })
      summary = result.content
      // The call really happened, so its cost is a fact worth reporting. A
      // provider that reported nothing leaves this absent rather than zero.
      usage = result.usage
    } catch (err) {
      // A failed summarization leaves history untouched; report why rather
      // than pretending no progress was possible.
      return { status: "failed", error: err instanceof Error ? err.message : String(err) }
    }
    if (summary.trim().length === 0) return { status: "no-progress", reason: "empty-summary" }

    const summaryMessage: ModelMessage = {
      role: "user",
      content: `[Compacted conversation summary]\n\n${summary}`,
    }
    const tail = messages.slice(preserved)
    await session.replaceMessages([summaryMessage, ...tail])
    return {
      status: "compacted",
      removed: older.length,
      ...(usage === undefined ? {} : { usage }),
    }
  }

  /**
   * Both budgets, from the one policy in `contextBudget()`. `maxOutputTokens`
   * is passed as the window itself so the model's own cap does not bind here —
   * the 75/25 split is the only rule applied.
   */
  private budgets(): { inputBudget: number; outputBudget: number } {
    const contextWindow = this.contextWindow ?? 0
    return contextBudget({ contextWindow, maxOutputTokens: contextWindow })
  }

  /** Tokens the summarization request may consume, leaving output headroom. */
  private summaryInputBudget(): number {
    if (this.contextWindow === undefined) return PRESERVE_MAX_TOKENS
    return this.budgets().inputBudget - this.budgets().outputBudget
  }

  /**
   * Drops the OLDEST messages until the summarization request fits, and
   * reports whether anything was dropped so the caller can disclose it. The
   * model is never handed a partial history presented as complete.
   */
  private boundSummaryInput(older: readonly SessionMessage[]): {
    messages: SessionMessage[]
    elided: boolean
  } {
    const budget = this.summaryInputBudget()
    const cost = (from: number): number =>
      estimateTokens([
        ...older.slice(from).map(m => ({ role: m.role, content: m.content }) as ModelMessage),
        { role: "user", content: SUMMARY_PROMPT },
      ])

    let start = 0
    while (start < older.length - 1 && cost(start) > budget) start++
    return { messages: older.slice(start), elided: start > 0 }
  }

  /** Recent-turn budget: 25% of the 75/25 input budget, clamped to
   *  [2000, 8000] estimated tokens (chars / 4). */
  private preserveBudgetTokens(): number {
    if (this.contextWindow === undefined) return PRESERVE_MAX_TOKENS
    const inputBudget = this.budgets().inputBudget
    return Math.max(PRESERVE_MIN_TOKENS, Math.min(PRESERVE_MAX_TOKENS, Math.floor(inputBudget * PRESERVE_BUDGET_RATIO)))
  }
}

function selectPreservedTail(messages: ModelMessage[], budgetTokens: number): number {
  const userTurns: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userTurns.push(i)
  }
  if (userTurns.length === 0) return 0

  let kept = messages.length
  let total = 0
  for (let i = userTurns.length - 1; i >= 0; i--) {
    const start = userTurns[i]
    const end = i < userTurns.length - 1 ? userTurns[i + 1] : messages.length
    const size = estimateTokens(messages.slice(start, end))
    if (total + size > budgetTokens) break
    total += size
    kept = start
  }
  return kept
}
