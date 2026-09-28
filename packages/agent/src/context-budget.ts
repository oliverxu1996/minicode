import type { ModelLimits, ModelMessage } from "@minicode/model"

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
 * deliberately does not carry context policy). Deciding *when* to compact
 * and rebuilding requests are further Runtime responsibilities; token
 * estimation lives here too, as {@link estimateTokens}.
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

/**
 * The single token estimator for the Runtime: `ceil(JSON chars / 4)`.
 *
 * Deliberately a heuristic — the repository has no tokenizer dependency, and
 * provider-reported usage only arrives *after* a response. Request-time
 * context safety therefore has to be estimated; this is the one place that
 * happens, so no second estimator may be introduced.
 */
export function estimateTokens(messages: readonly ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}
