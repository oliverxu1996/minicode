import type {
  Model,
  ModelEvent,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "@minicode/model"

export type ScriptedResponse =
  | ModelResponse
  | { error: Error }

/**
 * Deterministic fake `Model` for runtime tests: replays a script of
 * responses (or thrown errors) in order and records every request, so
 * control-flow assertions need no external model. The loop consumes the
 * scripted response through `stream()` as normalized events.
 */
export class FakeModel implements Model {
  readonly id: string
  readonly name: string
  readonly limits: { contextWindow: number; maxOutputTokens: number }
  readonly requests: ModelRequest[] = []

  private index = 0

  constructor(
    private readonly script: ScriptedResponse[],
    limits?: { contextWindow: number; maxOutputTokens: number },
  ) {
    this.id = "fake-model"
    this.name = "Fake Model"
    this.limits = limits ?? { contextWindow: 128000, maxOutputTokens: 32000 }
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
