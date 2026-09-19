/**
 * API protocol spoken by a configured model endpoint.
 *
 * The protocol describes the wire format, not the vendor: any service that
 * implements the OpenAI Chat Completions API is `"openai"`, and any service
 * that implements the Anthropic Messages API is `"anthropic"`.
 */
export type ModelProtocol = "openai" | "anthropic"

/**
 * User-supplied description of a model: what to call, where, and within which
 * limits.
 *
 * `endpoint` is used verbatim as the API base URL. It is never guessed at and
 * never extended with path segments such as `/v1` — configure the base URL the
 * provider expects.
 *
 * API keys are persisted with the configuration by design (local
 * application). They are never exposed through {@link Model} or any
 * normalized request, response, event, or error type.
 */
export interface ModelConfig {
  /** Unique, user-chosen identifier. Non-empty after trimming. */
  readonly id: string

  /** Human-readable display name. */
  readonly name: string

  /** API protocol the endpoint speaks. */
  readonly protocol: ModelProtocol

  /** Final API base URL, used verbatim. */
  readonly endpoint: string

  /** Model identifier as understood by the provider API. */
  readonly model: string

  /** API key sent with requests. */
  readonly apiKey: string

  /** Total context window in tokens. */
  readonly contextWindow: number

  /** Maximum output tokens per request. */
  readonly maxOutputTokens: number
}

/**
 * Token limits of a model. Publicly readable so the runtime can make
 * context-management decisions (see the 75/25 context-window policy, which is
 * owned by the Runtime).
 */
export interface ModelLimits {
  /** Total context window in tokens. */
  readonly contextWindow: number

  /** Maximum output tokens per request. */
  readonly maxOutputTokens: number
}

/** Role of a {@link ModelMessage}. */
export type ModelMessageRole = "system" | "user" | "assistant" | "tool"

/** Plain-text content within an assistant message. */
export interface ModelTextPart {
  readonly type: "text"
  readonly text: string
}

/**
 * A tool invocation requested by the model, embedded in conversation history.
 *
 * `toolCallId` is an opaque correlation identifier. It is the authoritative
 * link between a {@link ModelToolCallPart} in an assistant message and the
 * matching {@link ModelToolResult} in a tool message; neither array position
 * nor message position nor the tool name plays any correlating role.
 */
export interface ModelToolCallPart {
  readonly type: "tool_call"
  readonly toolCallId: string
  readonly toolName: string
  /** Structured input produced by the model. */
  readonly input: unknown
}

/** Content allowed inside an assistant message. */
export type ModelAssistantPart = ModelTextPart | ModelToolCallPart

/**
 * Model-visible output of a tool execution.
 *
 * This is not the raw execution result: the Runtime owns that, and transforms
 * (truncates, summarizes, serializes) it into what the model should see.
 * `tool_error` marks a failed execution; adapters preserve it where the
 * provider protocol can (Anthropic `is_error`) and degrade it to plain text
 * where the provider cannot (OpenAI-compatible endpoints).
 */
export type ModelToolOutput =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "json"; readonly value: unknown }
  | { readonly type: "tool_error"; readonly text: string }

/**
 * A model-visible tool result. Correlated with its originating
 * {@link ModelToolCallPart} through `toolCallId` alone.
 */
export interface ModelToolResult {
  readonly toolCallId: string
  readonly toolName: string
  readonly output: ModelToolOutput
}

/**
 * A canonical conversation message.
 *
 * The model is structured: assistant messages carry text and tool calls as
 * parts; tool messages carry results correlated by `toolCallId`. System and
 * user messages are plain text.
 */
export type ModelMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: readonly ModelAssistantPart[] }
  | { readonly role: "tool"; readonly content: readonly ModelToolResult[] }

/**
 * A tool the model may call. The model never executes tools; it only
 * produces tool calls that the Runtime executes.
 */
export interface ModelTool {
  /** Tool name as the model references it. */
  readonly name: string

  /** Human-readable description of what the tool does. */
  readonly description?: string

  /** JSON Schema describing the tool's input object. */
  readonly inputSchema: unknown
}

/** Why a model stopped generating. */
export type ModelFinishReason =
  | "stop"
  | "tool_call"
  | "length"
  | "error"
  | "unknown"

/** Token usage reported by the provider, when it reports any. */
export interface ModelUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

/**
 * A complete, non-streaming model response.
 *
 * The Runtime turns a response into history by appending an assistant message
 * (text part from `content`, one tool-call part per entry of `toolCalls`) and,
 * after executing the calls, one tool message per result.
 */
export interface ModelResponse {
  /** Assistant text content, empty when the model produced none. */
  readonly content: string

  /** Tool calls requested by the model, in provider order. */
  readonly toolCalls: readonly ModelToolCall[]

  /** Token usage, when the provider reported it. */
  readonly usage?: ModelUsage

  /** Why generation stopped. */
  readonly finishReason: ModelFinishReason
}

/** A tool invocation requested by the model. */
export interface ModelToolCall {
  /** Opaque correlation identifier for this invocation. */
  readonly toolCallId: string

  /** Name of the requested tool. */
  readonly toolName: string

  /** Structured input produced by the model. */
  readonly input: unknown
}

/**
 * A normalized model invocation request.
 *
 * The model knows its own limits; `contextWindow` is intentionally not part
 * of a request. `maxOutputTokens` is a per-request output ceiling chosen by
 * the caller (typically from the Runtime's 75/25 context-window budget).
 * Cancellation and timeout policy belong to the caller, expressed through
 * `signal`.
 */
export interface ModelRequest {
  /** Conversation messages, in order. */
  readonly messages: readonly ModelMessage[]

  /** Tools the model may request calls to. */
  readonly tools?: readonly ModelTool[]

  /** Per-request output ceiling in tokens. */
  readonly maxOutputTokens?: number

  /** Sampling temperature. */
  readonly temperature?: number

  /** Cancellation signal; an aborted signal always wins. */
  readonly signal?: AbortSignal
}

/**
 * Normalized streaming event. The adapter translates provider stream chunks
 * into these; no provider-specific stream shape ever crosses this boundary.
 *
 * A `tool_call` event carries a fully assembled call — partial tool input is
 * never surfaced, and a call is only executable once this event has arrived.
 */
export type ModelEvent =
  | {
      readonly type: "text_delta"
      readonly text: string
    }
  | {
      readonly type: "tool_call"
      readonly toolCall: ModelToolCall
    }
  | {
      readonly type: "usage"
      readonly usage: ModelUsage
    }
  | {
      readonly type: "finish"
      readonly reason: ModelFinishReason
    }

/**
 * A concrete callable model.
 *
 * Only identity and limits are exposed; the endpoint, protocol, and API key
 * stay private to the package. Invocation is fully normalized — neither
 * provider-specific objects nor SDK types appear on this surface.
 */
export interface Model {
  /** Unique identifier of the model configuration. */
  readonly id: string

  /** Human-readable display name. */
  readonly name: string

  /** Token limits of this model. */
  readonly limits: ModelLimits

  /** Sends the request and waits for the complete response. */
  generate(request: ModelRequest): Promise<ModelResponse>

  /** Sends the request and yields normalized stream events. */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
}
