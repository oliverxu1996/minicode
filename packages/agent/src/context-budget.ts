import type { ModelLimits } from "@minicode/model"

/** Token budgets derived from a model's limits. */
export interface ContextBudget {
  /** Tokens available for input/context. */
  readonly inputBudget: number

  /** Tokens available for output. */
  readonly outputBudget: number
}

/**
 * Splits a model's context window into input and output budgets using the
 * fixed MiniCode policy: 75% of the context window is reserved for input and
 * 25% for output, with the output budget additionally capped by the model's
 * own `maxOutputTokens`.
 *
 * This is the Runtime-owned context-budget arithmetic (the model package
 * deliberately does not carry context policy). Deciding *when* to compact,
 * estimating tokens, and rebuilding requests are further Runtime
 * responsibilities.
 *
 * ```txt
 * 128000 context + no max output  → input 96000 / output 32000
 * 128000 context + maxOutput 8000 → input 96000 / output  8000
 * ```
 */
export function contextBudget(limits: ModelLimits): ContextBudget {
  return {
    inputBudget: Math.floor(limits.contextWindow * 0.75),
    outputBudget: Math.min(
      Math.floor(limits.contextWindow * 0.25),
      limits.maxOutputTokens,
    ),
  }
}
