import { describe, expect, test } from "bun:test"
import { ModelError } from "./errors"
import type { Model, ModelEvent, ModelMessage } from "./index"
import {
  TEST_API_KEY,
  activeModelViaManager,
  anthropicDetailedUsageResponse,
  anthropicStreamEvents,
  anthropicTextResponse,
  anthropicToolUseResponse,
  hangingStream,
  openaiChunk,
  openaiDetailedUsageChunk,
  openaiDetailedUsageResponse,
  openaiTextResponse,
  openaiToolCallResponse,
  openaiUsageChunk,
  sse,
  startMockProvider,
  testConfig,
  withConfigDir,
} from "./test-support"

const TOOLS = [{
  name: "read_file",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
}] as const

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe("openai protocol: generate", () => {
  test("normalized text response with usage and finish reason", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => openaiTextResponse("Hello, world."))

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const response = await model.generate({
          messages: [{ role: "user", content: "hi" }],
        })

        expect(response).toEqual({
          content: "Hello, world.",
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          finishReason: "stop",
        })
      } finally {
        await provider.close()
      }
    })
  })

  test("tool calls are normalized from the provider representation", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        openaiToolCallResponse([{
          id: "call_1",
          name: "read_file",
          arguments: JSON.stringify({ path: "src/index.ts" }),
        }])
      )

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const response = await model.generate({
          messages: [{ role: "user", content: "read it" }],
          tools: TOOLS,
        })

        expect(response.finishReason).toBe("tool_call")
        expect(response.toolCalls).toEqual([{
          toolCallId: "call_1",
          toolName: "read_file",
          input: { path: "src/index.ts" },
        }])
      } finally {
        await provider.close()
      }
    })
  })

  test("assistant text round-trips through history to the wire", async () => {
    await withConfigDir(async () => {
      let captured: { path: string; body: any } | undefined
      const provider = await startMockProvider(request => {
        captured = request as { path: string; body: any }
        return openaiTextResponse("ok")
      })

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        await model.generate({
          messages: [
            { role: "system", content: "You are LoongCode." },
            { role: "user", content: "hi" },
            { role: "assistant", content: [{ type: "text", text: "hello" }] },
            { role: "user", content: "back" },
          ],
          maxOutputTokens: 4096,
          temperature: 0.2,
        })

        expect(captured?.path).toBe("/chat/completions")
        expect(captured?.body.messages).toEqual([
          { role: "system", content: "You are LoongCode." },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "back" },
        ])
        expect(captured?.body.max_tokens).toBe(4096)
        expect(captured?.body.temperature).toBe(0.2)
      } finally {
        await provider.close()
      }
    })
  })

  test("context exceeded is reported as context_exceeded", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => Response.json(
        {
          error: {
            message: "This model's maximum context length is 128000 tokens.",
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      ))

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        try {
          await model.generate({ messages: [{ role: "user", content: "hi" }] })
          throw new Error("expected generate to throw")
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect((error as ModelError).code).toBe("context_exceeded")
        }
      } finally {
        await provider.close()
      }
    })
  })

  test("authentication failure is reported without leaking the API key", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        Response.json({ error: { message: "invalid api key" } }, { status: 401 })
      )

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        try {
          await model.generate({ messages: [{ role: "user", content: "hi" }] })
          throw new Error("expected generate to throw")
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect((error as ModelError).code).toBe("authentication_failed")
          expect((error as ModelError).message).not.toContain(TEST_API_KEY)
        }
      } finally {
        await provider.close()
      }
    })
  })

  test("rate limit retries with Retry-After and then succeeds", async () => {
    await withConfigDir(async () => {
      let calls = 0
      const provider = await startMockProvider(() => {
        calls += 1
        if (calls <= 2) {
          return Response.json({ error: { message: "slow down" } }, {
            status: 429,
            headers: { "retry-after": "0" },
          })
        }
        return openaiTextResponse("recovered")
      })

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const response = await model.generate({ messages: [{ role: "user", content: "hi" }] })

        expect(response.content).toBe("recovered")
        expect(provider.requests).toHaveLength(3)
      } finally {
        await provider.close()
      }
    })
  })

  test("transient server error is retried once and then succeeds", async () => {
    await withConfigDir(async () => {
      let calls = 0
      const provider = await startMockProvider(() => {
        calls += 1
        if (calls === 1) return new Response("boom", { status: 500 })
        return openaiTextResponse("second try")
      })

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const response = await model.generate({ messages: [{ role: "user", content: "hi" }] })

        expect(response.content).toBe("second try")
        expect(provider.requests).toHaveLength(2)
      } finally {
        await provider.close()
      }
    })
  })

  test("rate limiting gives up after 2 retries", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        Response.json({ error: { message: "still limited" } }, {
          status: 429,
          headers: { "retry-after": "0" },
        })
      )

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        try {
          await model.generate({ messages: [{ role: "user", content: "hi" }] })
          throw new Error("expected generate to throw")
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect((error as ModelError).code).toBe("rate_limited")
          expect(provider.requests).toHaveLength(3)
        }
      } finally {
        await provider.close()
      }
    })
  })

  test("invalid provider response is reported as invalid_response", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => Response.json({ choices: "nope" }))

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        try {
          await model.generate({ messages: [{ role: "user", content: "hi" }] })
          throw new Error("expected generate to throw")
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect((error as ModelError).code).toBe("invalid_response")
        }
      } finally {
        await provider.close()
      }
    })
  })

  test("connection failure is retried and reported as request_failed", async () => {
    await withConfigDir(async () => {
      // A port with no listener: transport failure, not an HTTP error.
      const model = await activeModelViaManager(testConfig({ endpoint: "http://127.0.0.1:59999" }))
      try {
        await model.generate({ messages: [{ role: "user", content: "hi" }] })
        throw new Error("expected generate to throw")
      } catch (error) {
        expect(error).toBeInstanceOf(ModelError)
        expect((error as ModelError).code).toBe("request_failed")
      }
    })
  })

  test("cancellation before the request prevents any provider call", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => openaiTextResponse("late"))

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const controller = new AbortController()
        controller.abort()

        try {
          await model.generate({
            messages: [{ role: "user", content: "hi" }],
            signal: controller.signal,
          })
          throw new Error("expected generate to throw")
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect((error as ModelError).code).toBe("cancelled")
        }
        expect(provider.requests).toHaveLength(0)
      } finally {
        await provider.close()
      }
    })
  })

  test("cancellation during the request surfaces as cancelled", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(async () => {
        await new Promise(() => {}) // Hang until the client goes away.
        return openaiTextResponse("never")
      })

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const controller = new AbortController()
        const pending = model.generate({
          messages: [{ role: "user", content: "hi" }],
          signal: controller.signal,
        })
        setTimeout(() => controller.abort(), 50)

        try {
          await pending
          throw new Error("expected generate to throw")
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect((error as ModelError).code).toBe("cancelled")
        }
      } finally {
        await provider.close()
      }
    })
  })
})

describe("openai protocol: stream", () => {
  test("normalized stream events with usage and finish", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        sse([
          openaiChunk({ content: "Hel" }, null),
          openaiChunk({ content: "lo" }, null),
          openaiChunk({}, "stop"),
          openaiUsageChunk({ input: 10, output: 5 }),
          null,
        ])
      )

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const events = await collect(model.stream({
          messages: [{ role: "user", content: "hi" }],
        }))

        expect(events).toEqual([
          { type: "text_delta", text: "Hel" },
          { type: "text_delta", text: "lo" },
          { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          { type: "finish", reason: "stop" },
        ])
      } finally {
        await provider.close()
      }
    })
  })

  test("streamed tool calls are normalized", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        sse([
          openaiChunk({ tool_calls: [{
            index: 0,
            id: "call_9",
            type: "function",
            function: { name: "read_file", arguments: "" },
          }] }, null),
          openaiChunk({ tool_calls: [{
            index: 0,
            function: { arguments: JSON.stringify({ path: "a.ts" }) },
          }] }, null),
          openaiChunk({}, "tool_calls"),
          null,
        ])
      )

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const events = await collect(model.stream({
          messages: [{ role: "user", content: "read it" }],
          tools: TOOLS,
        }))

        expect(events).toEqual([
          {
            type: "tool_call",
            toolCall: { toolCallId: "call_9", toolName: "read_file", input: { path: "a.ts" } },
          },
          { type: "finish", reason: "tool_call" },
        ])
      } finally {
        await provider.close()
      }
    })
  })

  test("failure before any output is retried; exhausted retries throw", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => new Response("boom", { status: 500 }))

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        try {
          await collect(model.stream({ messages: [{ role: "user", content: "hi" }] }))
          throw new Error("expected stream to throw")
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect((error as ModelError).code).toBe("request_failed")
          expect(provider.requests).toHaveLength(3)
        }
      } finally {
        await provider.close()
      }
    })
  })

  test("failure after partial output throws instead of finishing", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        hangingStream([
          openaiChunk({ content: "partial" }, null),
          { error: { message: "connection reset" } },
        ])
      )

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const events: ModelEvent[] = []
        try {
          for await (const event of model.stream({
            messages: [{ role: "user", content: "hi" }],
          })) {
            events.push(event)
          }
          throw new Error("expected stream to throw")
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          // Exactly the partial output arrived, and no finish event followed.
          expect(events).toEqual([{ type: "text_delta", text: "partial" }])
        }
      } finally {
        await provider.close()
      }
    })
  })

  test("cancelling mid-stream surfaces as cancelled", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        hangingStream([openaiChunk({ content: "first" }, null)])
      )

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const controller = new AbortController()
        const events: ModelEvent[] = []
        try {
          for await (const event of model.stream({
            messages: [{ role: "user", content: "hi" }],
            signal: controller.signal,
          })) {
            events.push(event)
            controller.abort()
          }
          throw new Error("expected stream to throw")
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect((error as ModelError).code).toBe("cancelled")
          expect(events).toEqual([{ type: "text_delta", text: "first" }])
        }
      } finally {
        await provider.close()
      }
    })
  })
})

describe("anthropic protocol", () => {
  test("normalized text response", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => anthropicTextResponse("Bonjour."))

      try {
        const model = await activeModelViaManager(testConfig({
          protocol: "anthropic",
          model: "claude-sonnet-4-5",
          endpoint: provider.url,
        }))
        const response = await model.generate({ messages: [{ role: "user", content: "hi" }] })

        expect(response.content).toBe("Bonjour.")
        expect(response.finishReason).toBe("stop")
        expect(response.usage?.inputTokens).toBe(10)
        expect(response.usage?.outputTokens).toBe(5)
        expect(response.toolCalls).toEqual([])
      } finally {
        await provider.close()
      }
    })
  })

  test("tool use is normalized, including multiple calls per response", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        anthropicToolUseResponse([
          { id: "toolu_1", name: "read_file", input: { path: "b.ts" } },
          { id: "toolu_2", name: "read_file", input: { path: "c.ts" } },
        ])
      )

      try {
        const model = await activeModelViaManager(testConfig({
          protocol: "anthropic",
          model: "claude-sonnet-4-5",
          endpoint: provider.url,
        }))
        const response = await model.generate({
          messages: [{ role: "user", content: "read both" }],
          tools: TOOLS,
        })

        expect(response.finishReason).toBe("tool_call")
        expect(response.toolCalls).toEqual([
          { toolCallId: "toolu_1", toolName: "read_file", input: { path: "b.ts" } },
          { toolCallId: "toolu_2", toolName: "read_file", input: { path: "c.ts" } },
        ])
      } finally {
        await provider.close()
      }
    })
  })

  test("normalized stream events", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        sse(anthropicStreamEvents(["Hel", "lo"], "end_turn", { input: 10, output: 5 }))
      )

      try {
        const model = await activeModelViaManager(testConfig({
          protocol: "anthropic",
          model: "claude-sonnet-4-5",
          endpoint: provider.url,
        }))
        const events = await collect(model.stream({ messages: [{ role: "user", content: "hi" }] }))

        expect(events).toEqual([
          { type: "text_delta", text: "Hel" },
          { type: "text_delta", text: "lo" },
          { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          { type: "finish", reason: "stop" },
        ])
      } finally {
        await provider.close()
      }
    })
  })

  test("context exceeded maps to context_exceeded", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => Response.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" },
        },
        { status: 400 },
      ))

      try {
        const model = await activeModelViaManager(testConfig({
          protocol: "anthropic",
          model: "claude-sonnet-4-5",
          endpoint: provider.url,
        }))
        try {
          await model.generate({ messages: [{ role: "user", content: "hi" }] })
          throw new Error("expected generate to throw")
        } catch (error) {
          expect((error as ModelError).code).toBe("context_exceeded")
        }
      } finally {
        await provider.close()
      }
    })
  })

  test("authentication failure maps to authentication_failed", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => Response.json(
        { type: "error", error: { type: "authentication_error", message: "bad key" } },
        { status: 401 },
      ))

      try {
        const model = await activeModelViaManager(testConfig({
          protocol: "anthropic",
          model: "claude-sonnet-4-5",
          endpoint: provider.url,
        }))
        try {
          await model.generate({ messages: [{ role: "user", content: "hi" }] })
          throw new Error("expected generate to throw")
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect((error as ModelError).code).toBe("authentication_failed")
          expect((error as ModelError).message).not.toContain(TEST_API_KEY)
        }
      } finally {
        await provider.close()
      }
    })
  })
})

// ---- Canonical history round-trips (design contract §19) -------------------
//
// These validate the semantic invariant of the canonical protocol: a tool
// call produced by the model can be placed into history and answered by a
// tool result, and the wire request preserves the call↔result correlation
// through toolCallId alone — regardless of result ordering.

/** Builds the canonical follow-up history for calls A and B: an assistant
 *  turn holding both calls, then a tool turn answering them out of order
 *  (B first, A second) with a structured and a failing result. */
function roundTripHistory(): ModelMessage[] {
  return [
    { role: "user", content: "look at a.ts and b.ts" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Reading both files." },
        { type: "tool_call", toolCallId: "call_A", toolName: "read_file", input: { path: "a.ts" } },
        { type: "tool_call", toolCallId: "call_B", toolName: "read_file", input: { path: "b.ts" } },
      ],
    },
    {
      role: "tool",
      content: [
        { toolCallId: "call_B", toolName: "read_file", output: { type: "json", value: { lines: 2 } } },
        { toolCallId: "call_A", toolName: "read_file", output: { type: "text", text: "export {}" } },
      ],
    },
  ]
}

describe("canonical history: openai conversion", () => {
  test("one tool call round-trip preserves correlation on the wire", async () => {
    await withConfigDir(async () => {
      let calls = 0
      const provider = await startMockProvider(() => {
        calls += 1
        if (calls === 1) {
          return openaiToolCallResponse([{
            id: "call_A",
            name: "read_file",
            arguments: JSON.stringify({ path: "a.ts" }),
          }])
        }
        return openaiTextResponse("done")
      })

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const first = await model.generate({
          messages: [{ role: "user", content: "look at a.ts" }],
          tools: TOOLS,
        })
        expect(first.toolCalls).toHaveLength(1)

        // Runtime executes the call and rebuilds history for the next step.
        await model.generate({
          messages: [
            { role: "user", content: "look at a.ts" },
            {
              role: "assistant",
              content: [
                { type: "tool_call", ...first.toolCalls[0] },
              ],
            },
            {
              role: "tool",
              content: [{
                toolCallId: "call_A",
                toolName: "read_file",
                output: { type: "text", text: "export {}" },
              }],
            },
          ],
          tools: TOOLS,
        })

        const wire = provider.requests[1].body as any
        expect(wire.messages[1].role).toBe("assistant")
        expect(wire.messages[1].tool_calls).toEqual([{
          id: "call_A",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
        }])
        expect(wire.messages[2]).toEqual({
          role: "tool",
          tool_call_id: "call_A",
          content: "export {}",
        })
      } finally {
        await provider.close()
      }
    })
  })

  test("multiple calls with out-of-order, structured results stay correlated", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => openaiTextResponse("done"))

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        await model.generate({ messages: roundTripHistory(), tools: TOOLS })

        const wire = provider.requests[0].body as any
        const assistant = wire.messages[1]
        expect(assistant.role).toBe("assistant")
        expect(assistant.content).toBe("Reading both files.")
        expect(assistant.tool_calls.map((call: any) => call.id)).toEqual(["call_A", "call_B"])
        expect(assistant.tool_calls.map((call: any) => call.function.name)).toEqual([
          "read_file",
          "read_file",
        ])

        // Results arrive in sent order (B first) — correlation is by id only.
        const toolMessages = wire.messages.slice(2)
        expect(toolMessages).toEqual([
          {
            role: "tool",
            tool_call_id: "call_B",
            content: JSON.stringify({ lines: 2 }),
          },
          { role: "tool", tool_call_id: "call_A", content: "export {}" },
        ])
      } finally {
        await provider.close()
      }
    })
  })

  test("tool errors degrade to plain text, as the wire protocol allows", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => openaiTextResponse("done"))

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        await model.generate({
          messages: [
            { role: "user", content: "look at missing.ts" },
            {
              role: "assistant",
              content: [
                { type: "tool_call", toolCallId: "call_X", toolName: "read_file", input: { path: "missing.ts" } },
              ],
            },
            {
              role: "tool",
              content: [{
                toolCallId: "call_X",
                toolName: "read_file",
                output: { type: "tool_error", text: "file not found" },
              }],
            },
          ],
          tools: TOOLS,
        })

        const wire = provider.requests[0].body as any
        // OpenAI Chat Completions has no error flag: the failure text is all
        // that survives, attached to the correct call id.
        expect(wire.messages[2]).toEqual({
          role: "tool",
          tool_call_id: "call_X",
          content: "file not found",
        })
      } finally {
        await provider.close()
      }
    })
  })
})

describe("canonical history: anthropic conversion", () => {
  test("round-trip preserves tool_use/tool_result pairing and is_error", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => anthropicTextResponse("done"))

      try {
        const model = await activeModelViaManager(testConfig({
          protocol: "anthropic",
          model: "claude-sonnet-4-5",
          endpoint: provider.url,
        }))
        await model.generate({
          messages: [
            ...roundTripHistory().slice(0, 2),
            {
              role: "tool",
              content: [
                { toolCallId: "call_A", toolName: "read_file", output: { type: "text", text: "export {}" } },
                { toolCallId: "call_B", toolName: "read_file", output: { type: "tool_error", text: "permission denied" } },
              ],
            },
          ],
          tools: TOOLS,
        })

        const wire = provider.requests[0].body as any
        const assistant = wire.messages.find((message: any) => message.role === "assistant")
        const toolUse = assistant.content.filter((block: any) => block.type === "tool_use")
        expect(toolUse.map((block: any) => block.id)).toEqual(["call_A", "call_B"])
        expect(toolUse[0]).toMatchObject({ name: "read_file", input: { path: "a.ts" } })

        // Consecutive results ride in one user message, as Anthropic requires.
        const user = wire.messages.filter((message: any) => message.role === "user")
        const results = user.flatMap((message: any) =>
          message.content.filter((block: any) => block.type === "tool_result")
        )
        expect(results).toEqual([
          { type: "tool_result", tool_use_id: "call_A", content: "export {}", is_error: undefined },
          {
            type: "tool_result",
            tool_use_id: "call_B",
            content: "permission denied",
            is_error: true,
          },
        ])
      } finally {
        await provider.close()
      }
    })
  })
})

describe("usage detail: cache and reasoning", () => {
  // The provider reports a breakdown of the two token totals. It must survive
  // normalization, and it must never be folded into those totals.

  test("openai: cache read and reasoning survive normalization", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        openaiDetailedUsageResponse("Hello.", {
          promptTokens: 1050,
          completionTokens: 20,
          cachedTokens: 900,
          reasoningTokens: 7,
        })
      )

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const response = await model.generate({ messages: [{ role: "user", content: "hi" }] })

        expect(response.usage).toEqual({
          inputTokens: 1050,
          outputTokens: 20,
          totalTokens: 1070,
          cacheReadTokens: 900,
          reasoningTokens: 7,
        })
        // This protocol has no cache-write concept, so the field is absent
        // rather than carried as zero.
        expect(response.usage).not.toHaveProperty("cacheWriteTokens")
      } finally {
        await provider.close()
      }
    })
  })

  test("anthropic: cache read, cache write and reasoning survive normalization", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        anthropicDetailedUsageResponse("Hello.", {
          inputTokens: 100, // the non-cached portion this API reports
          outputTokens: 20,
          cacheReadTokens: 900,
          cacheWriteTokens: 50,
          reasoningTokens: 7,
        })
      )

      try {
        const model = await activeModelViaManager(testConfig({
          protocol: "anthropic",
          model: "claude-sonnet-4-5",
          endpoint: provider.url,
        }))
        const response = await model.generate({ messages: [{ role: "user", content: "hi" }] })

        // The inclusive total folds in both cache components…
        expect(response.usage).toEqual({
          inputTokens: 1050,
          outputTokens: 20,
          totalTokens: 1070,
          cacheReadTokens: 900,
          cacheWriteTokens: 50,
          reasoningTokens: 7,
        })
        // …and the detail decomposes it instead of adding to it.
        const usage = response.usage!
        expect(usage.cacheReadTokens! + usage.cacheWriteTokens!).toBeLessThanOrEqual(usage.inputTokens!)
        expect(usage.reasoningTokens!).toBeLessThanOrEqual(usage.outputTokens!)
      } finally {
        await provider.close()
      }
    })
  })

  test("openai stream: cache read and reasoning survive the streaming boundary", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        sse([
          openaiChunk({ content: "Hello." }, null),
          openaiChunk({}, "stop"),
          openaiDetailedUsageChunk({
            promptTokens: 1050,
            completionTokens: 20,
            cachedTokens: 900,
            reasoningTokens: 7,
          }),
          null,
        ])
      )

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const events = await collect(model.stream({
          messages: [{ role: "user", content: "hi" }],
        }))

        expect(events).toContainEqual({
          type: "usage",
          usage: {
            inputTokens: 1050,
            outputTokens: 20,
            totalTokens: 1070,
            cacheReadTokens: 900,
            reasoningTokens: 7,
          },
        })
      } finally {
        await provider.close()
      }
    })
  })

  test("anthropic stream: a cache write survives (no openai equivalent)", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        sse(anthropicStreamEvents(["Hello."], "end_turn", { input: 100, output: 20 }, {
          cacheReadTokens: 900,
          cacheWriteTokens: 50,
          reasoningTokens: 7,
        }))
      )

      try {
        const model = await activeModelViaManager(testConfig({
          protocol: "anthropic",
          model: "claude-sonnet-4-5",
          endpoint: provider.url,
        }))
        const events = await collect(model.stream({ messages: [{ role: "user", content: "hi" }] }))

        expect(events).toContainEqual({
          type: "usage",
          usage: {
            inputTokens: 1050,
            outputTokens: 20,
            totalTokens: 1070,
            cacheReadTokens: 900,
            cacheWriteTokens: 50,
            reasoningTokens: 7,
          },
        })
      } finally {
        await provider.close()
      }
    })
  })

  test("an unreported breakdown stays absent, never zero", async () => {
    await withConfigDir(async () => {
      // This fixture reports only the two totals. The SDK supplies 0 for the
      // breakdown; "not reported" must stay distinguishable from "zero".
      const provider = await startMockProvider(() => openaiTextResponse("Hello."))

      try {
        const model = await activeModelViaManager(testConfig({ endpoint: provider.url }))
        const response = await model.generate({ messages: [{ role: "user", content: "hi" }] })

        expect(response.usage).toEqual({
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        })
      } finally {
        await provider.close()
      }
    })
  })
})
