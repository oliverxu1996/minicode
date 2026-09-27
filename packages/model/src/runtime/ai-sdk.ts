import {
  APICallError,
  AISDKError,
  dynamicTool,
  generateText,
  jsonSchema,
  streamText,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  InvalidToolInputError,
  JSONParseError,
  NoContentGeneratedError,
  NoOutputGeneratedError,
  TypeValidationError,
} from "ai"
import type {
  AssistantContent,
  FinishReason as SDKFinishReason,
  JSONSchema7,
  JSONValue,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage as SDKModelMessage,
  ToolResultPart,
  ToolSet,
} from "ai"
import { cancelledError, ModelError, ModelErrorCode } from "../errors"
import type {
  ModelAssistantPart,
  ModelConfig,
  ModelEvent,
  ModelFinishReason,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelToolOutput,
  ModelToolResult,
  ModelUsage,
} from "../types"
import { anthropicLanguageModel } from "../protocol/anthropic"
import { openaiLanguageModel } from "../protocol/openai"

/** Retries of a single invocation after a transient failure. */
const MAX_RETRIES = 2

/** Base delay for exponential backoff: 250ms, 500ms. */
const BASE_BACKOFF_MS = 250

/** Provider error messages that indicate the request exceeded the context
 *  window, across the protocols this package supports. */
const CONTEXT_EXCEEDED_PATTERN =
  /maximum context length|context_length_exceeded|prompt is too long|exceeds the context window|input length and .max_tokens. exceed context limit/i

/**
 * Protocol adapter backing {@link Model} with the Vercel AI SDK.
 *
 * Owns the responsibilities the contract assigns to the model integration
 * layer: provider adaptation, error normalization, and retry of transient
 * failures. The SDK is an implementation detail — none of its types leave
 * this file.
 */
export class AISDKRuntime {
  constructor(private readonly config: ModelConfig) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const result = await this.withRetry(request.signal, () =>
      generateText({
        model: this.languageModel(),
        messages: toSDKMessages(request.messages),
        allowSystemInMessages: true,
        tools: toSDKTools(request.tools),
        ...toSDKSettings(request),
        abortSignal: request.signal,
        // Retries are owned here, not by the SDK.
        maxRetries: 0,
      }),
    )

    return {
      content: result.text,
      toolCalls: result.toolCalls.map(toToolCall),
      usage: toUsage(result.usage),
      finishReason: toFinishReason(result.finishReason),
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const signal = request.signal
    // Linked controller so an early consumer `break` also cancels the
    // in-flight provider request.
    const linked = new AbortController()
    const forwardAbort = () => linked.abort()
    signal?.addEventListener("abort", forwardAbort, { once: true })

    let completed = false
    try {
      let attempt = 0
      while (true) {
        if (signal?.aborted) throw cancelledError()

        // A retry re-runs the whole request, so it may only happen before
        // the first event reaches the consumer; otherwise output would
        // duplicate.
        let emitted = false
        try {
          const result = streamText({
            model: this.languageModel(),
            messages: toSDKMessages(request.messages),
            allowSystemInMessages: true,
            tools: toSDKTools(request.tools),
            ...toSDKSettings(request),
            abortSignal: linked.signal,
            // Retries are owned here, not by the SDK.
            maxRetries: 0,
          })

          for await (const part of result.fullStream) {
            if (part.type === "error") throw part.error
            if (part.type === "abort") throw cancelledError()

            switch (part.type) {
              case "text-delta":
                emitted = true
                yield { type: "text_delta", text: part.text }
                break
              case "reasoning-delta":
                emitted = true
                yield { type: "reasoning_delta", text: part.text }
                break
              case "tool-call":
                emitted = true
                yield { type: "tool_call", toolCall: toToolCall(part) }
                break
              case "finish": {
                emitted = true
                const usage = toUsage(part.totalUsage)
                if (usage) yield { type: "usage", usage }
                yield { type: "finish", reason: toFinishReason(part.finishReason) }
                break
              }
              default:
                // Provider-specific bookkeeping parts (text-start, reasoning,
                // raw, …) carry nothing the normalized surface needs.
                break
            }
          }

          if (signal?.aborted) throw cancelledError()
          completed = true
          return
        } catch (error) {
          // Errors the package raised itself (cancellation) are already
          // normalized; never re-wrap them.
          if (error instanceof ModelError) throw error
          if (signal?.aborted) throw cancelledError()
          const failure = classify(error)
          if (!emitted && failure.retryable && attempt < MAX_RETRIES) {
            attempt += 1
            await sleep(failure.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** (attempt - 1), signal)
            continue
          }
          throw this.toModelError(error, failure)
        }
      }
    } finally {
      signal?.removeEventListener("abort", forwardAbort)
      if (!completed) linked.abort()
    }
  }

  private languageModel(): LanguageModel {
    // Protocol selection picks an internal adapter; the endpoint and API key
    // are passed through verbatim. A new protocol is a new adapter here, not
    // a change to the public surface.
    switch (this.config.protocol) {
      case "openai":
        return openaiLanguageModel(this.config)
      case "anthropic":
        return anthropicLanguageModel(this.config)
    }
  }

  /** Retries an invocation on transient failures. Cancellation always wins:
   *  an aborted signal short-circuits both the attempt and the backoff. */
  private async withRetry<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw cancelledError()
      try {
        return await operation()
      } catch (error) {
        // Errors the package raised itself (cancellation) are already
        // normalized; never re-wrap them.
        if (error instanceof ModelError) throw error
        if (signal?.aborted) throw cancelledError()
        const failure = classify(error)
        if (!failure.retryable || attempt >= MAX_RETRIES) {
          throw this.toModelError(error, failure)
        }
        await sleep(failure.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** attempt, signal)
      }
    }
  }

  /** Converts a failure into a ModelError. The message is scrubbed of the
   *  configured API key as a defense against provider errors echoing request
   *  material back. */
  private toModelError(error: unknown, failure: ReturnType<typeof classify>): ModelError {
    const detail = error instanceof Error ? error.message : String(error)
    const source = detail.length > 0 ? detail : "no detail provided"
    const key = this.config.apiKey
    const safe = key.length > 0 ? source.split(key).join("***") : source
    return new ModelError(failure.code, `${failure.code}: ${safe}`)
  }
}

/** Transient-failure classification used to decide retry behavior. */
interface Failure {
  readonly code: ModelErrorCode
  readonly retryable: boolean

  /** Delay requested by the provider via `Retry-After`, when present. */
  readonly retryAfterMs?: number
}

/**
 * Normalizes any thrown value into a {@link Failure}.
 *
 * Transient failures — HTTP 429, HTTP 5xx, network errors — are retryable.
 * Authentication failures, invalid requests, cancellation, context
 * exhaustion, and uninterpretable responses are not.
 */
function classify(error: unknown): Failure {
  if (isAbortLike(error)) {
    return { code: "cancelled", retryable: false }
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode
    const retryAfterMs = parseRetryAfter(error.responseHeaders?.["retry-after"])

    if (status === 401 || status === 403) {
      return { code: "authentication_failed", retryable: false }
    }
    // Providers report transient overload/limit conditions with assorted
    // status codes and body codes (e.g. BigModel 1302/1305 with HTTP 400);
    // they are retryable regardless of the HTTP status.
    if (isProviderOverload(error)) {
      return { code: "rate_limited", retryable: true, retryAfterMs }
    }
    if (status === 429) {
      return { code: "rate_limited", retryable: true, retryAfterMs }
    }
    if (status !== undefined && status >= 500) {
      return { code: "request_failed", retryable: true, retryAfterMs }
    }
    if (isContextExceeded(error)) {
      return { code: "context_exceeded", retryable: false }
    }
    // A protocol violation reported over a successful HTTP response: the
    // provider answered 2xx but the payload does not match its own API.
    if (status !== undefined && status >= 200 && status < 300) {
      return { code: "invalid_response", retryable: false }
    }
    // Network-level failures surface as APICallError without a status code.
    if (status === undefined) {
      return { code: "request_failed", retryable: true, retryAfterMs }
    }
    return { code: "request_failed", retryable: false }
  }

  if (
    TypeValidationError.isInstance(error) ||
    JSONParseError.isInstance(error) ||
    InvalidResponseDataError.isInstance(error) ||
    EmptyResponseBodyError.isInstance(error) ||
    NoContentGeneratedError.isInstance(error) ||
    NoOutputGeneratedError.isInstance(error) ||
    InvalidToolInputError.isInstance(error)
  ) {
    return { code: "invalid_response", retryable: false }
  }

  if (AISDKError.isInstance(error)) {
    return { code: "request_failed", retryable: false }
  }

  if (isNetworkError(error)) {
    return { code: "request_failed", retryable: true }
  }

  return { code: "request_failed", retryable: false }
}

/** Detects transport-level failures (refused connections, DNS, dropped
 *  sockets) from either runtime's fetch, so they can be retried. */
const NETWORK_ERRNOS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
])

const NETWORK_MESSAGE_PATTERN =
  /unable to connect|fetch failed|network error|socket|connection (?:refused|reset|closed)|terminated|premature close/i

function isNetworkError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === "string" && NETWORK_ERRNOS.has(code)) return true
    if (
      current instanceof TypeError &&
      NETWORK_MESSAGE_PATTERN.test(current.message)
    ) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function isContextExceeded(error: APICallError): boolean {
  if (error.statusCode !== 400 && error.statusCode !== 413) return false
  const text = `${error.message} ${error.responseBody ?? ""}`
  return CONTEXT_EXCEEDED_PATTERN.test(text)
}

/** Provider body/message markers for transient overload or throttling. */
const PROVIDER_OVERLOAD_PATTERN =
  /访问量过大|稍后再试|rate limit|too many requests|overloaded|please try again later|\bcode["']?\s*[:=]\s*["']?130[25]/i

function isProviderOverload(error: APICallError): boolean {
  if (error.statusCode === 429) return true
  const text = `${error.message} ${error.responseBody ?? ""} ${JSON.stringify(error.data ?? "")}`
  return PROVIDER_OVERLOAD_PATTERN.test(text)
}

/** Detects cancellation raised as an AbortError anywhere in the cause chain. */
function isAbortLike(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.name === "AbortError" || (current as { code?: unknown }).code === "ABORT_ERR") {
      return true
    }
    current = current.cause
  }
  return false
}

/** Parses a `Retry-After` header value (delay-seconds or HTTP-date) to ms. */
function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(cancelledError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Maps MiniCode messages to SDK messages.
 *
 * Tool-call/tool-result correlation is preserved structurally: assistant
 * `tool_call` parts become SDK tool-call parts, and tool results become SDK
 * tool-result parts carrying the same `toolCallId`. The provider adapters
 * then translate these into each wire protocol's pairing mechanism
 * (OpenAI `tool_calls`/`tool_call_id`, Anthropic `tool_use`/`tool_use_id`).
 */
function toSDKMessages(messages: ModelRequest["messages"]): SDKModelMessage[] {
  return messages.map(message => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content }
      case "user":
        return { role: "user", content: message.content }
      case "assistant":
        return {
          role: "assistant",
          content: message.content.map(toSDKAssistantPart),
        }
      case "tool":
        return {
          role: "tool",
          content: message.content.map(toSDKToolResult),
        }
    }
  })
}

/** The part variants of an SDK assistant content array. */
type SDKAssistantPart = Exclude<AssistantContent, string>[number]

function toSDKAssistantPart(part: ModelAssistantPart): SDKAssistantPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text }
    case "tool_call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      }
  }
}

function toSDKToolResult(result: ModelToolResult): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    output: toSDKToolOutput(result.output),
  }
}

/** Model-visible output kinds this package produces. A local structural
 *  subset of the SDK's output union. */
type SDKToolOutput =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "json"; readonly value: JSONValue }
  | { readonly type: "error-text"; readonly value: string }

/** `tool_error` maps to the SDK's `error-text` output kind: the Anthropic
 *  adapter turns that into `is_error: true`, the OpenAI adapter degrades it
 *  to a plain string — the strongest representation each wire protocol
 *  carries. */
function toSDKToolOutput(output: ModelToolOutput): SDKToolOutput {
  switch (output.type) {
    case "text":
      return { type: "text", value: output.text }
    case "json":
      // `undefined` is not representable on any wire; serialize it as null.
      return { type: "json", value: (output.value ?? null) as JSONValue }
    case "tool_error":
      return { type: "error-text", value: output.text }
  }
}

/** Wraps each tool as a dynamic (runtime-defined) tool with its JSON Schema. */
function toSDKTools(tools: ModelRequest["tools"]): ToolSet | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return Object.fromEntries(
    tools.map(tool => [
      tool.name,
      dynamicTool({
        description: tool.description,
        inputSchema: jsonSchema(tool.inputSchema as JSONSchema7),
      }),
    ]),
  )
}

/** Per-request sampling settings. Unset options are omitted entirely rather
 *  than passed as `undefined` — providers treat an explicit key differently
 *  from an absent one (e.g. Anthropic's unknown-model output cap). */
function toSDKSettings(request: ModelRequest): {
  maxOutputTokens?: number
  temperature?: number
} {
  const settings: { maxOutputTokens?: number; temperature?: number } = {}
  if (request.maxOutputTokens !== undefined) settings.maxOutputTokens = request.maxOutputTokens
  if (request.temperature !== undefined) settings.temperature = request.temperature
  return settings
}

function toToolCall(call: { toolCallId: string; toolName: string; input: unknown }): ModelToolCall {
  return { toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }
}

/** Unknown usage stays unknown: fields the provider did not report are
 *  omitted, never zero-filled. */
function toUsage(usage: LanguageModelUsage | undefined): ModelUsage | undefined {
  if (usage === undefined) return undefined
  const normalized: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  } = {}
  if (usage.inputTokens != null) normalized.inputTokens = usage.inputTokens
  if (usage.outputTokens != null) normalized.outputTokens = usage.outputTokens
  if (usage.totalTokens != null) normalized.totalTokens = usage.totalTokens
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

/** SDK finish reasons not present in the normalized vocabulary
 *  (`content-filter`, `other`) map to `"unknown"`. */
function toFinishReason(reason: SDKFinishReason): ModelFinishReason {
  switch (reason) {
    case "stop":
      return "stop"
    case "tool-calls":
      return "tool_call"
    case "length":
      return "length"
    case "error":
      return "error"
    case "content-filter":
    case "other":
      return "unknown"
  }
}
