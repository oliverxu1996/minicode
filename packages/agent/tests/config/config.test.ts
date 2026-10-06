import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSettings, projectSettingsPath, globalSettingsPath } from "../../src/config/settings"
import { formatProjectInstructions, loadProjectContext } from "../../src/config/context"
import { loadResources } from "../../src/config/resources"
import { isProjectTrusted, trustProject as trustProjectFn } from "../../src/config/trust"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "minicode-product-test-"))
}

describe("settings (AC10)", () => {
  test("defaults apply when no files exist", () => {
    const dir = tempDir()
    try {
      const loaded = loadSettings(dir)
      expect(loaded.settings.autoCompact).toEqual({ enabled: true, thresholdPct: 80 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("project settings override global settings with deep merge", () => {
    const dir = tempDir()
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      const globalPath = globalSettingsPath()
      const projectPath = projectSettingsPath(dir)
      mkdirSync(dir, { recursive: true })
      mkdirSync(join(dir, ".minicode"), { recursive: true })
      mkdirSync(globalSettingsPath().replace("/settings.json", ""), { recursive: true })
      writeFileSync(globalPath, JSON.stringify({ autoCompact: { enabled: true, thresholdPct: 90 } }))
      mkdirSync(dir, { recursive: true })
      writeFileSync(projectPath, JSON.stringify({ autoCompact: { thresholdPct: 50 }, model: "mine" }))

      const loaded = loadSettings(dir)
      // Project wins per key…
      expect(loaded.settings.autoCompact?.thresholdPct).toBe(50)
      // …while unset global sub-keys carry through (deep merge).
      expect(loaded.settings.autoCompact?.enabled).toBe(true)
      expect(loaded.settings.model).toBe("mine")
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed settings throw with the file path", () => {
    const dir = tempDir()
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      mkdirSync(join(dir, "minicode"), { recursive: true })
      writeFileSync(globalSettingsPath(), "{ broken")
      expect(() => loadSettings(dir)).toThrow(/malformed|invalid settings file/)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("project context (AC9)", () => {
  test("AGENTS.md is loaded and formatted as project instructions", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "AGENTS.md"), "Always write tests first.")
    const context = loadProjectContext(dir)
    expect(context?.content).toBe("Always write tests first.")
    const formatted = formatProjectInstructions(context)
    expect(formatted).toContain("<project_instructions")
    expect(formatted).toContain("Always write tests first.")
    rmSync(dir, { recursive: true, force: true })
  })

  test("AGENTS.override.md takes precedence", () => {
    const dir = tempDir()
    writeFileSync(join(dir, "AGENTS.md"), "base")
    writeFileSync(join(dir, "AGENTS.override.md"), "override")
    expect(loadProjectContext(dir)?.content).toBe("override")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("resources and project trust (AC13/AC17)", () => {
  test("project prompts are gated behind trust", () => {
    const dir = tempDir()
    const promptsDir = join(dir, ".minicode", "prompts")
    mkdirSync(promptsDir, { recursive: true })
    writeFileSync(join(promptsDir, "review.md"), "Review the diff carefully.")

    const untrusted = loadResources(dir, false)
    expect(untrusted.prompts).toEqual([])
    expect(untrusted.untrustedProjectResources).toBe(true)

    const trusted = loadResources(dir, true)
    expect(trusted.prompts).toEqual([{ name: "review", content: "Review the diff carefully.", source: "project" }])
    rmSync(dir, { recursive: true, force: true })
  })

  test("trust decision persists", () => {
    const dir = tempDir()
    trustProjectFn(dir)
    expect(isProjectTrusted(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("user prompt templates load without trust", () => {
    const dir = tempDir()
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      const promptsDir = join(dir, "minicode", "prompts")
      mkdirSync(promptsDir, { recursive: true })
      writeFileSync(join(promptsDir, "daily.md"), "Do the daily thing.")
      const resources = loadResources(dir, false)
      expect(resources.prompts).toEqual([{ name: "daily", content: "Do the daily thing.", source: "user" }])
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
