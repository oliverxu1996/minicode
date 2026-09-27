import type { Model, ModelMessage, ModelUsage } from "@minicode/model"
import { contextBudget } from "../context-budget"
import type { Session } from "../session/session"

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

/**
 * Reactive context management:
 *
 * - `isOverflow`: the last model call's reported input usage reached the
 *   75% input budget — the next call cannot fit, so compact now.
 * - `compact`: LLM-summarize the older turns (all but a preserved recent
 *   tail) into a single user message and splice it into history.
 *
 * Deliberately no pre-request token estimation: v0.1 keeps the baseline
 * simple and the 75/25 policy defines the only threshold.
 */
export class Compactor {
  constructor(
    private readonly model: Model,
    private readonly contextWindow: number | undefined,
  ) {}

  isOverflow(usage: ModelUsage | undefined): boolean {
    if (this.contextWindow === undefined) return false
    if (usage === undefined || usage.inputTokens === undefined) return false
    const inputBudget = contextBudget({ contextWindow: this.contextWindow, maxOutputTokens: 1 }).inputBudget
    return usage.inputTokens >= inputBudget
  }

  /** Rewrites history around an LLM summary and returns the number of
   *  messages removed (0 = no progress). Never throws. */
  async compact(session: Session): Promise<number> {
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
    if (lastUserIdx < 0 || lastUserIdx === messages.length - 1) return 0

    const compactable = messages.slice(0, lastUserIdx + 1)
    const preserved = selectPreservedTail(compactable, this.preserveBudgetTokens())
    if (preserved <= 0) return 0

    const older = compactable.slice(0, preserved)
    if (older.length === 0) return 0

    const summaryMessages: ModelMessage[] = [
      ...older.map(m => ({ role: m.role, content: m.content }) as ModelMessage),
      { role: "user", content: SUMMARY_PROMPT },
    ]

    let summary: string
    try {
      const result = await this.model.generate({
        messages: summaryMessages,
        temperature: 0,
      })
      summary = result.content
    } catch {
      // A failed summarization leaves history untouched; the caller decides
      // whether to stop rather than risk an unrecoverable overflow loop.
      return 0
    }
    if (summary.trim().length === 0) return 0

    const summaryMessage: ModelMessage = {
      role: "user",
      content: `[Compacted conversation summary]\n\n${summary}`,
    }
    const tail = messages.slice(preserved)
    session.replaceMessages([summaryMessage, ...tail])
    return older.length
  }

  /** Recent-turn budget: 25% of the 75/25 input budget, clamped to
   *  [2000, 8000] estimated tokens (chars / 4). */
  private preserveBudgetTokens(): number {
    if (this.contextWindow === undefined) return PRESERVE_MAX_TOKENS
    const inputBudget = contextBudget({ contextWindow: this.contextWindow, maxOutputTokens: 1 }).inputBudget
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

function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}
