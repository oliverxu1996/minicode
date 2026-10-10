import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { loadState, saveState, statePath } from "./persistence"
import { testConfig } from "./test-support"

/**
 * The model layer resolves the configuration directory itself — it cannot
 * import the agent's resolver, which depends on this package, not the other
 * way round. These pin the exact root it computes, so the two resolvers
 * cannot drift into reading different directories.
 */
describe("model persistence — one config root", () => {
  test("defaults to ~/.loongcode/models.json", () => {
    const previous = process.env.LOONGCODE_CONFIG_DIR
    try {
      delete process.env.LOONGCODE_CONFIG_DIR
      // Path arithmetic only: nothing is read or written under the real home.
      expect(statePath()).toBe(join(homedir(), ".loongcode", "models.json"))
    } finally {
      if (previous !== undefined) process.env.LOONGCODE_CONFIG_DIR = previous
    }
  })

  test("LOONGCODE_CONFIG_DIR redirects where state is read and written", () => {
    const dir = mkdtempSync(join(tmpdir(), "loongcode-persistence-"))
    const previous = process.env.LOONGCODE_CONFIG_DIR
    process.env.LOONGCODE_CONFIG_DIR = dir
    try {
      expect(statePath()).toBe(join(dir, "models.json"))
      expect(loadState()).toEqual({ version: 1, models: [], activeModelId: null })

      saveState([testConfig()], null)

      expect(existsSync(join(dir, "models.json"))).toBe(true)
      expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf-8")).version).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.LOONGCODE_CONFIG_DIR
      else process.env.LOONGCODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
