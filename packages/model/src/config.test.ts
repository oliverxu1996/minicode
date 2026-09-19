import { describe, expect, test } from "bun:test"
import { validateModelConfig } from "./config"
import { ModelError } from "./errors"
import type { ModelConfig } from "./types"
import { testConfig } from "./test-support"

function expectRejected(overrides: Partial<ModelConfig>): void {
  const config = testConfig(overrides)
  expect(() => validateModelConfig(config, "model configuration")).toThrow(ModelError)
}

describe("model configuration validation", () => {
  test("a valid configuration passes unchanged", () => {
    const config = testConfig()
    expect(validateModelConfig(config, "model configuration")).toEqual(config)
  })

  test("empty id rejected", () => {
    expectRejected({ id: "" })
    expectRejected({ id: "   " })
  })

  test("id is trimmed on validation", () => {
    const validated = validateModelConfig(testConfig({ id: "  my-model " }), "x")
    expect(validated.id).toBe("my-model")
  })

  test("empty name rejected", () => {
    expectRejected({ name: "" })
    expectRejected({ name: "   " })
  })

  test("empty model identifier rejected", () => {
    expectRejected({ model: "" })
  })

  test("unknown protocol rejected", () => {
    expectRejected({ protocol: "deepseek" as never })
  })

  test("invalid endpoint rejected", () => {
    expectRejected({ endpoint: "not a url" })
    expectRejected({ endpoint: "ftp://example.com" })
    expectRejected({ endpoint: "" })
  })

  test("http and https endpoints accepted verbatim", () => {
    expect(validateModelConfig(testConfig({ endpoint: "http://127.0.0.1:8080" }), "x").endpoint)
      .toBe("http://127.0.0.1:8080")
    expect(validateModelConfig(testConfig({ endpoint: "https://api.example.com/v1" }), "x").endpoint)
      .toBe("https://api.example.com/v1")
  })

  test("invalid context window rejected", () => {
    expectRejected({ contextWindow: 0 })
    expectRejected({ contextWindow: -5 })
    expectRejected({ contextWindow: 1.5 })
    expectRejected({ contextWindow: Number.NaN })
  })

  test("invalid max output tokens rejected", () => {
    expectRejected({ maxOutputTokens: 0 })
    expectRejected({ maxOutputTokens: -1 })
    expectRejected({ maxOutputTokens: 100.25 })
  })

  test("max output tokens greater than context window rejected", () => {
    expectRejected({ contextWindow: 1000, maxOutputTokens: 1001 })
  })

  test("equal context window and max output accepted", () => {
    expect(() =>
      validateModelConfig(testConfig({ contextWindow: 1000, maxOutputTokens: 1000 }), "x")
    ).not.toThrow()
  })

  test("missing api key rejected", () => {
    expect(() =>
      validateModelConfig({ ...testConfig(), apiKey: undefined as never }, "x")
    ).toThrow(ModelError)
  })

  test("non-object input rejected", () => {
    expect(() => validateModelConfig(null, "x")).toThrow(ModelError)
    expect(() => validateModelConfig("model", "x")).toThrow(ModelError)
    expect(() => validateModelConfig([testConfig()], "x")).toThrow(ModelError)
  })
})
