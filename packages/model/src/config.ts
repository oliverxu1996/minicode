import { configurationError } from "./errors"
import type { ModelConfig, ModelProtocol } from "./types"

const PROTOCOLS: readonly ModelProtocol[] = ["openai", "anthropic"]

/**
 * Validates untrusted input as a {@link ModelConfig} and returns the
 * normalized configuration (identifiers trimmed).
 *
 * Throws a `configuration_error` ModelError when any requirement is violated.
 * `label` names the configuration in error messages, e.g.
 * `"model configuration"` or `"models.json entry \"x\""`.
 */
export function validateModelConfig(input: unknown, label: string): ModelConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw configurationError(`${label} must be an object`)
  }

  const record = input as Record<string, unknown>

  const id = requireNonEmptyString(record.id, `${label}.id`)
  const name = requireNonEmptyString(record.name, `${label}.name`)
  const model = requireNonEmptyString(record.model, `${label}.model`)
  const endpoint = requireEndpoint(record.endpoint, label)
  const apiKey = requireString(record.apiKey, `${label}.apiKey`)
  const protocol = requireProtocol(record.protocol, label)
  const contextWindow = requirePositiveInteger(
    record.contextWindow,
    `${label}.contextWindow`,
  )
  const maxOutputTokens = requirePositiveInteger(
    record.maxOutputTokens,
    `${label}.maxOutputTokens`,
  )

  if (maxOutputTokens > contextWindow) {
    throw configurationError(
      `${label}.maxOutputTokens (${maxOutputTokens}) must not exceed contextWindow (${contextWindow})`,
    )
  }

  return { id, name, protocol, endpoint, model, apiKey, contextWindow, maxOutputTokens }
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label)
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw configurationError(`${label} must be a non-empty string`)
  }
  return trimmed
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw configurationError(`${label} must be a string`)
  }
  return value
}

/** The endpoint is the final API base URL: it must parse as http(s) and is
 *  never modified further. */
function requireEndpoint(value: unknown, label: string): string {
  const text = requireString(value, `${label}.endpoint`)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw configurationError(`${label}.endpoint must be a valid URL`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configurationError(`${label}.endpoint must be an http(s) URL`)
  }
  return text
}

function requireProtocol(value: unknown, label: string): ModelProtocol {
  if (typeof value !== "string" || !PROTOCOLS.includes(value as ModelProtocol)) {
    throw configurationError(
      `${label}.protocol must be one of: ${PROTOCOLS.join(", ")}`,
    )
  }
  return value as ModelProtocol
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw configurationError(`${label} must be a positive integer`)
  }
  return value
}
