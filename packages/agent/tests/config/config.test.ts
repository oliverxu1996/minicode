import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { configDir } from "../../src/config/dir"
import { loadSettings, projectSettingsPath, globalSettingsPath } from "../../src/config/settings"
import { formatProjectInstructions, loadProjectContext } from "../../src/config/context"
import { loadResources, listPromptTemplates } from "../../src/config/resources"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "loongcode-product-test-"))
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
    const previous = process.env.LOONGCODE_CONFIG_DIR
    process.env.LOONGCODE_CONFIG_DIR = dir
    try {
      const globalPath = globalSettingsPath()
      const projectPath = projectSettingsPath(dir)
      mkdirSync(dir, { recursive: true })
      mkdirSync(join(dir, ".loongcode"), { recursive: true })
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
      if (previous === undefined) delete process.env.LOONGCODE_CONFIG_DIR
      else process.env.LOONGCODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed settings throw with the file path", () => {
    const dir = tempDir()
    const previous = process.env.LOONGCODE_CONFIG_DIR
    process.env.LOONGCODE_CONFIG_DIR = dir
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(globalSettingsPath(), "{ broken")
      expect(() => loadSettings(dir)).toThrow(/malformed|invalid settings file/)
    } finally {
      if (previous === undefined) delete process.env.LOONGCODE_CONFIG_DIR
      else process.env.LOONGCODE_CONFIG_DIR = previous
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
    const promptsDir = join(dir, ".loongcode", "prompts")
    mkdirSync(promptsDir, { recursive: true })
    writeFileSync(join(promptsDir, "review.md"), "Review the diff carefully.")

    const resources = loadResources(dir)
    expect(resources.prompts).toEqual([{ name: "review", content: "Review the diff carefully.", source: "project" }])
    rmSync(dir, { recursive: true, force: true })
  })

  test("project skills load without any trust state", () => {
    const dir = tempDir()
    const skillDir = join(dir, ".loongcode", "skills", "demo")
    mkdirSync(skillDir, { recursive: true })
    const content = "description: Demo skill\n\nDo the demo thing.\n"
    writeFileSync(join(skillDir, "SKILL.md"), content)

    const resources = loadResources(dir)
    expect(resources.skills).toEqual([{ name: "demo", description: "Demo skill", content, source: "project" }])
    rmSync(dir, { recursive: true, force: true })
  })

  test("global prompts and skills still load", () => {
    const dir = tempDir()
    const previous = process.env.LOONGCODE_CONFIG_DIR
    process.env.LOONGCODE_CONFIG_DIR = dir
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
      if (previous === undefined) delete process.env.LOONGCODE_CONFIG_DIR
      else process.env.LOONGCODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("listPromptTemplates lists names and sources without reading contents, live", () => {
    const dir = tempDir()
    const userDir = tempDir()
    const previous = process.env.LOONGCODE_CONFIG_DIR
    process.env.LOONGCODE_CONFIG_DIR = userDir
    try {
      const projectPrompts = join(dir, ".loongcode", "prompts")
      mkdirSync(projectPrompts, { recursive: true })
      writeFileSync(join(projectPrompts, "review.md"), "Review the diff.")
      const userPrompts = join(userDir, "prompts")
      mkdirSync(userPrompts, { recursive: true })
      writeFileSync(join(userPrompts, "daily.md"), "Daily.")

      // User templates first, then project — the order loadResources uses.
      expect(listPromptTemplates(dir)).toEqual([
        { name: "daily", source: "user" },
        { name: "review", source: "project" },
      ])

      // Additions are discovered immediately; removals drop out.
      writeFileSync(join(projectPrompts, "fresh.md"), "Fresh.")
      expect(listPromptTemplates(dir)).toContainEqual({ name: "fresh", source: "project" })
      rmSync(join(projectPrompts, "review.md"))
      expect(listPromptTemplates(dir).map(t => t.name)).not.toContain("review")
    } finally {
      if (previous === undefined) delete process.env.LOONGCODE_CONFIG_DIR
      else process.env.LOONGCODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  test("listPromptTemplates ignores non-markdown entries and directories", () => {
    const dir = tempDir()
    const userDir = tempDir()
    const previous = process.env.LOONGCODE_CONFIG_DIR
    process.env.LOONGCODE_CONFIG_DIR = userDir
    try {
      const projectPrompts = join(dir, ".loongcode", "prompts")
      mkdirSync(join(projectPrompts, "not-a-template.md"), { recursive: true })
      writeFileSync(join(projectPrompts, "notes.txt"), "not markdown")
      writeFileSync(join(projectPrompts, "real.md"), "real")
      expect(listPromptTemplates(dir)).toEqual([{ name: "real", source: "project" }])
    } finally {
      if (previous === undefined) delete process.env.LOONGCODE_CONFIG_DIR
      else process.env.LOONGCODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
      rmSync(userDir, { recursive: true, force: true })
    }
  })
})

describe("user config directory (~/.loongcode)", () => {
  test("configDir honors LOONGCODE_CONFIG_DIR", () => {
    const dir = tempDir()
    const previous = process.env.LOONGCODE_CONFIG_DIR
    process.env.LOONGCODE_CONFIG_DIR = dir
    try {
      expect(configDir()).toBe(dir)
    } finally {
      if (previous === undefined) delete process.env.LOONGCODE_CONFIG_DIR
      else process.env.LOONGCODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the agent config root", () => {
  test("defaults to ~/.loongcode and honours the override", () => {
    const previous = process.env.LOONGCODE_CONFIG_DIR
    try {
      // The default: no override, no filesystem access — just the path.
      // `@loongcode/model` resolves the same directory independently (its
      // package test pins the same literal), which is what makes one root
      // out of two resolvers.
      delete process.env.LOONGCODE_CONFIG_DIR
      expect(configDir()).toBe(join(homedir(), ".loongcode"))

      // And the override redirects it.
      process.env.LOONGCODE_CONFIG_DIR = "/tmp/loongcode-root-probe"
      expect(configDir()).toBe("/tmp/loongcode-root-probe")
    } finally {
      if (previous === undefined) delete process.env.LOONGCODE_CONFIG_DIR
      else process.env.LOONGCODE_CONFIG_DIR = previous
    }
  })
})
