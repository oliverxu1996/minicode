import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import type { ModelConfig } from "../types"

/**
 * Builds the AI SDK model for an `"openai"` protocol configuration.
 *
 * `endpoint` is passed through as the base URL verbatim and `config.model`
 * identifies the model on the Chat Completions API — the interoperable
 * protocol shared by OpenAI-compatible services (OpenAI, DeepSeek, OpenRouter,
 * local servers, …).
 *
 * Internal to the package: the returned object is an implementation detail
 * and never crosses the public boundary.
 */
export function openaiLanguageModel(config: ModelConfig): LanguageModel {
  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.endpoint,
  })
  return provider.chat(config.model)
}
