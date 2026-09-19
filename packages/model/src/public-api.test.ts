import { describe, expect, test } from "bun:test"
import * as publicApi from "./index"
import { testConfig, withConfigDir } from "./test-support"

describe("public API boundary", () => {
  test("exports exactly the intended runtime values", () => {
    // The 75/25 context-budget helper is Runtime-owned (agent package), not
    // part of this package's surface.
    expect(Object.keys(publicApi).sort()).toEqual([
      "ModelError",
      "ModelManager",
    ])
  })

  test("Model exposes only identity, limits, and invocation", async () => {
    await withConfigDir(async () => {
      const manager = await publicApi.ModelManager.load()
      const model = manager.add(testConfig())

      // Own properties: identity and limits only — no endpoint, no protocol,
      // no API key, no SDK objects.
      expect(Object.keys(model).sort()).toEqual(["id", "limits", "name"])

      // Prototype: invocation methods only — no getters for configuration.
      const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(model))
        .filter(name => name !== "constructor")
        .sort()
      expect(prototypeMethods).toEqual(["generate", "stream"])
    })
  })

  test("generated responses expose no SDK or provider objects", async () => {
    await withConfigDir(async () => {
      const { startMockProvider, openaiTextResponse } = await import("./test-support")
      const provider = await startMockProvider(() => openaiTextResponse("ok"))

      try {
        const manager = await publicApi.ModelManager.load()
        manager.add(testConfig({ endpoint: provider.url }))
        const response = await manager.active()!.generate({
          messages: [{ role: "user", content: "hi" }],
        })

        expect(Object.keys(response).sort()).toEqual([
          "content",
          "finishReason",
          "toolCalls",
          "usage",
        ])
        expect(Object.keys(response.usage!).sort()).toEqual([
          "inputTokens",
          "outputTokens",
          "totalTokens",
        ])
      } finally {
        await provider.close()
      }
    })
  })
})
