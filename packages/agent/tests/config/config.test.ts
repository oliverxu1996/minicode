import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configDir, copyLegacyConfigIfNeeded } from "../../src/config/dir"
import { loadSettings, projectSettingsPath, globalSettingsPath } from "../../src/config/settings"
import { formatProjectInstructions, loadProjectContext } from "../../src/config/context"
import { loadResources } from "../../src/config/resources"

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
    const previous = process.env.MINICODE_CONFIG_DIR
    process.env.MINICODE_CONFIG_DIR = dir
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
      if (previous === undefined) delete process.env.MINICODE_CONFIG_DIR
      else process.env.MINICODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed settings throw with the file path", () => {
    const dir = tempDir()
    const previous = process.env.MINICODE_CONFIG_DIR
    process.env.MINICODE_CONFIG_DIR = dir
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(globalSettingsPath(), "{ broken")
      expect(() => loadSettings(dir)).toThrow(/malformed|invalid settings file/)
    } finally {
      if (previous === undefined) delete process.env.MINICODE_CONFIG_DIR
      else process.env.MINICODE_CONFIG_DIR = previous
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

describe("resources (AC13/AC17)", () => {
  test("project prompts load without any trust state", () => {
    const dir = tempDir()
    const promptsDir = join(dir, ".minicode", "prompts")
    mkdirSync(promptsDir, { recursive: true })
    writeFileSync(join(promptsDir, "review.md"), "Review the diff carefully.")

    const resources = loadResources(dir)
    expect(resources.prompts).toEqual([{ name: "review", content: "Review the diff carefully.", source: "project" }])
    rmSync(dir, { recursive: true, force: true })
  })

  test("project skills load without any trust state", () => {
    const dir = tempDir()
    const skillDir = join(dir, ".minicode", "skills", "demo")
    mkdirSync(skillDir, { recursive: true })
    const content = "description: Demo skill\n\nDo the demo thing.\n"
    writeFileSync(join(skillDir, "SKILL.md"), content)

    const resources = loadResources(dir)
    expect(resources.skills).toEqual([{ name: "demo", description: "Demo skill", content, source: "project" }])
    rmSync(dir, { recursive: true, force: true })
  })

  test("global prompts and skills still load", () => {
    const dir = tempDir()
    const previous = process.env.MINICODE_CONFIG_DIR
    process.env.MINICODE_CONFIG_DIR = dir
    try {
      const promptsDir = join(dir, "prompts")
      mkdirSync(promptsDir, { recursive: true })
      writeFileSync(join(promptsDir, "daily.md"), "Do the daily thing.")
      const skillDir = join(dir, "skills", "daily")
      mkdirSync(skillDir, { recursive: true })
      const skillContent = "description: Daily skill\n\nDo the daily thing.\n"
      writeFileSync(join(skillDir, "SKILL.md"), skillContent)

      const resources = loadResources(dir)
      expect(resources.prompts).toEqual([{ name: "daily", content: "Do the daily thing.", source: "user" }])
      expect(resources.skills).toEqual([
        { name: "daily", description: "Daily skill", content: skillContent, source: "user" },
      ])
    } finally {
      if (previous === undefined) delete process.env.MINICODE_CONFIG_DIR
      else process.env.MINICODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("user config directory (~/.minicode)", () => {
  test("configDir honors MINICODE_CONFIG_DIR", () => {
    const dir = tempDir()
    const previous = process.env.MINICODE_CONFIG_DIR
    process.env.MINICODE_CONFIG_DIR = dir
    try {
      expect(configDir()).toBe(dir)
    } finally {
      if (previous === undefined) delete process.env.MINICODE_CONFIG_DIR
      else process.env.MINICODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a legacy tree is copied into the new dir and the original is left untouched", () => {
    const from = tempDir()
    const to = join(tempDir(), ".minicode")
    try {
      mkdirSync(join(from, "sessions"), { recursive: true })
      writeFileSync(join(from, "models.json"), '{"version":1,"models":[],"activeModelId":null}')
      writeFileSync(join(from, "sessions", "s.json"), "{}")

      copyLegacyConfigIfNeeded(from, to)

      expect(readFileSync(join(to, "models.json"), "utf-8")).toContain('"version":1')
      expect(existsSync(join(to, "sessions", "s.json"))).toBe(true)
      // Non-destructive: the source survives.
      expect(existsSync(join(from, "models.json"))).toBe(true)
    } finally {
      rmSync(from, { recursive: true, force: true })
      rmSync(to, { recursive: true, force: true })
    }
  })

  test("migration is a no-op when the target already exists", () => {
    const from = tempDir()
    const to = tempDir()
    try {
      writeFileSync(join(from, "models.json"), "legacy")
      writeFileSync(join(to, "models.json"), "current")

      copyLegacyConfigIfNeeded(from, to)

      // The existing target wins — migration never overwrites it.
      expect(readFileSync(join(to, "models.json"), "utf-8")).toBe("current")
    } finally {
      rmSync(from, { recursive: true, force: true })
      rmSync(to, { recursive: true, force: true })
    }
  })

  test("migration is a no-op when there is no legacy tree", () => {
    const to = join(tempDir(), ".minicode")
    try {
      copyLegacyConfigIfNeeded(join(tmpdir(), "minicode-does-not-exist-xyz"), to)
      expect(existsSync(to)).toBe(false)
    } finally {
      rmSync(to, { recursive: true, force: true })
    }
  })
})
