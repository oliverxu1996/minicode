import { ModelError } from "@loongcode/model"
import type {
  Model,
  ModelEvent,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "@loongcode/model"
import { estimateTokens } from "../../src/context/budget"

export type ScriptedResponse =
  | ModelResponse
  | { error: Error }

/** Limits, plus an optional synthetic input ceiling the fake provider enforces. */
export interface FakeModelLimits {
  contextWindow: number
  maxOutputTokens: number
  /**
   * When set, the fake *provider* rejects a request whose estimated input
   * exceeds this, the way a real one rejects an over-window request. The
   * scripted response is not consumed, so the caller can retry after reducing
   * context — this is what lets a test prove the request was made small enough
   * *before* it was sent, rather than merely that the code knows what a
   * context error is.
   */
  maxInputTokens?: number
}

/**
 * Deterministic fake `Model` for runtime tests: replays a script of
 * responses (or thrown errors) in order and records every request, so
 * control-flow assertions need no external model. The loop consumes the
 * scripted response through `stream()` as normalized events.
 *
 * `requests` and `requestSizes` make the *actual* generated request
 * inspectable and measurable with the runtime's own estimator, which is what
 * request-size safety assertions require.
 */
export class FakeModel implements Model {
  readonly id: string
  readonly name: string
  readonly protocol: Model["protocol"] = "openai"
  readonly model = "fake-model"
  readonly limits: { contextWindow: number; maxOutputTokens: number }
  readonly requests: ModelRequest[] = []
  /** Estimated input tokens of each recorded request, in call order. */
  readonly requestSizes: number[] = []

  private readonly maxInputTokens: number | undefined

  private index = 0

  constructor(
    private readonly script: ScriptedResponse[],
    limits?: FakeModelLimits,
  ) {
    this.id = "fake-model"
    this.name = "Fake Model"
    this.limits = limits ?? { contextWindow: 128000, maxOutputTokens: 32000 }
    this.maxInputTokens = limits?.maxInputTokens
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const step = this.next(request)
    return step
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await this.generate(request)
    if (response.content.length > 0) {
      yield { type: "text_delta", text: response.content }
    }
    for (const call of response.toolCalls) {
      yield { type: "tool_call", toolCall: call }
    }
    if (response.usage) {
      yield { type: "usage", usage: response.usage }
    }
    yield { type: "finish", reason: response.finishReason }
  }

  private next(request: ModelRequest): ModelResponse {
    this.requests.push(request)
    const estimated = estimateTokens(request.messages)
    this.requestSizes.push(estimated)
    if (this.maxInputTokens !== undefined && estimated > this.maxInputTokens) {
      // A provider-style rejection. The script is deliberately NOT consumed, so
      // a caller that reduces context and retries gets the real response.
      throw new ModelError(
        "context_exceeded",
        `FakeModel: estimated ${estimated} input tokens exceeds maxInputTokens ${this.maxInputTokens}`,
      )
    }
    const step = this.script[this.index]
    this.index += 1
    if (step === undefined) throw new Error(`FakeModel: no scripted response for call ${this.index - 1}`)
    if ("error" in step) throw step.error
    return step
  }
}

export function textResponse(text: string, opts?: {
  usage?: { inputTokens?: number; outputTokens?: number }
  finishReason?: "stop" | "length"
}): ModelResponse {
  return {
    content: text,
    toolCalls: [],
    finishReason: opts?.finishReason ?? "stop",
    usage: opts?.usage,
  }
}

export function toolCallResponse(
  calls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
  opts?: { usage?: { inputTokens?: number; outputTokens?: number } },
): ModelResponse {
  const toolCalls: ModelToolCall[] = calls.map(call => ({
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
  }))
  return {
    content: "",
    toolCalls,
    finishReason: "tool_call",
    usage: opts?.usage,
  }
}
