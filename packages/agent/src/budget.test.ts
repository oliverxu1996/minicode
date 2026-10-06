import { describe, expect, test } from "bun:test"
import { contextBudget } from "./context/budget"

describe("contextBudget (75/25 policy, Runtime-owned)", () => {
  test("128000 context window splits into 96000 input / 32000 output", () => {
    expect(contextBudget({ contextWindow: 128000, maxOutputTokens: 32000 })).toEqual({
      inputBudget: 96000,
      outputBudget: 32000,
    })
  })

  test("128000 context with 8000 max output caps output at 8000", () => {
    expect(contextBudget({ contextWindow: 128000, maxOutputTokens: 8000 })).toEqual({
      inputBudget: 96000,
      outputBudget: 8000,
    })
  })

  test("200000 context with 64000 max output splits into 150000 / 50000", () => {
    expect(contextBudget({ contextWindow: 200000, maxOutputTokens: 64000 })).toEqual({
      inputBudget: 150000,
      outputBudget: 50000,
    })
  })

  test("1000000 context with 128000 max output splits into 750000 / 128000", () => {
    expect(contextBudget({ contextWindow: 1000000, maxOutputTokens: 128000 })).toEqual({
      inputBudget: 750000,
      outputBudget: 128000,
    })
  })

  test("budgets never exceed the context window on odd sizes", () => {
    const budget = contextBudget({ contextWindow: 1000001, maxOutputTokens: 1000001 })
    expect(budget.inputBudget + budget.outputBudget).toBeLessThanOrEqual(1000001)
  })
})
