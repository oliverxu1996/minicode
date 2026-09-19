import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Model, ModelConfig } from "./index"
import { ModelManager } from "./index"

/**
 * Runs `run` with `XDG_CONFIG_HOME` redirected to a fresh temporary
 * directory, restoring the environment and removing the directory after.
 *
 * Configuration loads and mutations execute synchronously once triggered, so
 * setting the environment variable and starting `run` in the same tick makes
 * each call observe its own directory even if test files interleave.
 */
export async function withConfigDir<T>(run: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "minicode-model-test-"))
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = dir
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The configuration file path inside the current config dir. */
export function configFile(): string {
  return join(
    process.env.XDG_CONFIG_HOME!,
    "minicode",
    "models.json",
  )
}

/** Writes a configuration file directly, bypassing the manager. */
export function writeConfigFile(content: string): void {
  mkdirSync(join(process.env.XDG_CONFIG_HOME!, "minicode"), { recursive: true })
  writeFileSync(configFile(), content, "utf-8")
}

/** Reads the raw configuration file content. */
export function readConfigFile(): string {
  return readFileSync(configFile(), "utf-8")
}

export const TEST_API_KEY = "sk-test-secret-123"

/** A valid configuration, overridable per test. */
export function testConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    id: "test-model",
    name: "Test Model",
    protocol: "openai",
    endpoint: "http://127.0.0.1:9",
    model: "test-model",
    apiKey: TEST_API_KEY,
    contextWindow: 128000,
    maxOutputTokens: 32000,
    ...overrides,
  }
}

/** Loads a manager, registers `config`, and returns the resulting active
 *  model — the same path a real consumer takes. */
export async function activeModelViaManager(config: ModelConfig): Promise<Model> {
  const manager = await ModelManager.load()
  manager.add(config)
  const model = manager.active()
  if (model === undefined) throw new Error("expected the first model to become active")
  return model
}

/** A mock provider HTTP server. Every request is recorded. */
export interface MockProvider {
  /** Base URL to configure as a model endpoint. */
  url: string
  /** Recorded requests, in order. */
  requests: {
    path: string
    headers: Record<string, string>
    body: unknown
  }[]
  close(): Promise<void>
}

/**
 * Starts a disposable HTTP server whose responses are produced by `handler`.
 * Used to exercise the real protocol path (HTTP → provider → SDK →
 * normalization) without contacting an actual provider.
 */
export async function startMockProvider(
  handler: (request: { path: string; headers: Record<string, string>; body: unknown }) =>
    Response | Promise<Response>,
): Promise<MockProvider> {
  const requests: MockProvider["requests"] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => {
        headers[key] = value
      })
      let body: unknown
      try {
        body = JSON.parse(await request.text())
      } catch {
        body = null
      }
      requests.push({ path: url.pathname, headers, body })
      return handler({ path: url.pathname, headers, body })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    close: () => {
      server.stop(true)
      return Promise.resolve()
    },
  }
}

/** Encodes Server-Sent Events; `null` entries become `data: [DONE]`. */
export function sse(events: (unknown | null)[]): Response {
  const body = events
    .map(event => event === null ? "data: [DONE]\n\n" : `data: ${JSON.stringify(event)}\n\n`)
    .join("")
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

/** A stream that emits the given events and then hangs open, for testing
 *  cancellation mid-stream. */
export function hangingStream(events: unknown[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      // Never closes.
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

// ---- OpenAI Chat Completions fixtures -------------------------------------

export function openaiTextResponse(
  text: string,
  usage?: { input: number; output: number },
): Response {
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.input,
          completion_tokens: usage.output,
          total_tokens: usage.input + usage.output,
        }
      : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })
}

export function openaiToolCallResponse(
  calls: { id: string; name: string; arguments: string }[],
): Response {
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map(call => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  })
}

export function openaiChunk(delta: Record<string, unknown>, finishReason: string | null): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

export function openaiUsageChunk(usage: { input: number; output: number }): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [],
    usage: {
      prompt_tokens: usage.input,
      completion_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    },
  }
}

// ---- Anthropic Messages fixtures -------------------------------------------

export function anthropicTextResponse(text: string): Response {
  return Response.json({
    id: "msg-test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  })
}

export function anthropicToolUseResponse(
  calls: { id: string; name: string; input: unknown }[],
): Response {
  return Response.json({
    id: "msg-test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: calls.map(call => ({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 7 },
  })
}

export function anthropicStreamEvents(
  deltas: string[],
  stopReason: string,
  usage: { input: number; output: number },
): unknown[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg-test",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [],
        usage: { input_tokens: usage.input },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...deltas.map(text => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: usage.output },
    },
    { type: "message_stop" },
  ]
}
