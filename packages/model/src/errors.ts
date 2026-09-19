/**
 * Error code describing a model failure class.
 *
 * Provider and SDK failures are normalized into these codes; nothing
 * provider-specific crosses the package boundary.
 */
export type ModelErrorCode =
  | "configuration_error"
  | "authentication_failed"
  | "rate_limited"
  | "request_failed"
  | "context_exceeded"
  | "invalid_response"
  | "cancelled"

/**
 * Error raised by `@minicode/model` for configuration, persistence, and
 * invocation failures.
 *
 * Messages never contain API keys, authorization headers, or other
 * credentials.
 */
export class ModelError extends Error {
  /** Failure class. */
  readonly code: ModelErrorCode

  constructor(code: ModelErrorCode, message: string) {
    super(message)
    this.name = "ModelError"
    this.code = code
  }
}

/** Creates a `configuration_error` ModelError. Internal to the package. */
export function configurationError(message: string): ModelError {
  return new ModelError("configuration_error", message)
}

/** Creates a `cancelled` ModelError. Internal to the package. */
export function cancelledError(): ModelError {
  return new ModelError("cancelled", "request cancelled")
}
