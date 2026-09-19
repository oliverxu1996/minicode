import { createAnthropic } from "@ai-sdk/anthropic"
import type { LanguageModel } from "ai"
import type { ModelConfig } from "../types"

/**
 * Builds the AI SDK model for an `"anthropic"` protocol configuration.
 *
 * `endpoint` is passed through as the base URL verbatim and `config.model`
 * identifies the model on the Messages API.
 *
 * Internal to the package: the returned object is an implementation detail
 * and never crosses the public boundary.
 */
export function anthropicLanguageModel(config: ModelConfig): LanguageModel {
  const provider = createAnthropic({
    apiKey: config.apiKey,
    baseURL: config.endpoint,
  })
  return provider.messages(config.model)
}
