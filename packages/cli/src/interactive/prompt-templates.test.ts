import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listPromptTemplates } from "@minicode/agent"
import { COMMANDS, findCommand } from "./commands"
import { autocompleteItems, resolveSlashInput } from "./app"
import { MiniCodeAutocomplete } from "./input/autocomplete"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "minicode-templates-test-"))
}

/** Runs a test against a throwaway project and user config dir. */
async function withProject(run: (dir: string, userDir: string) => void | Promise<void>): Promise<void> {
  const dir = tempDir()
  const userDir = tempDir()
  const previous = process.env.MINICODE_CONFIG_DIR
  process.env.MINICODE_CONFIG_DIR = userDir
  try {
    await run(dir, userDir)
  } finally {
    if (previous === undefined) delete process.env.MINICODE_CONFIG_DIR
    else process.env.MINICODE_CONFIG_DIR = previous
    rmSync(dir, { recursive: true, force: true })
    rmSync(userDir, { recursive: true, force: true })
  }
}

function writeTemplate(root: string, name: string, content: string, scope: "project" | "user" = "project"): void {
  const dir = scope === "user" ? join(root, "prompts") : join(root, ".minicode", "prompts")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), content)
}

describe("live prompt-template discovery", () => {
  test("a template created after startup is discoverable and resolvable with no refresh", async () => {
    await withProject(async dir => {
      // The state at startup: an existing template is already discoverable.
      writeTemplate(dir, "existing", "Existing body")
      expect(listPromptTemplates(dir)).toContainEqual({ name: "existing", source: "project" })
      expect(resolveSlashInput(dir, "existing")).toEqual({ kind: "template", content: "Existing body" })

      // A template added while the application is running appears live.
      writeTemplate(dir, "fresh", "Fresh body")
      expect(listPromptTemplates(dir)).toContainEqual({ name: "fresh", source: "project" })

      const provider = new MiniCodeAutocomplete(
        () => autocompleteItems(dir),
        () => dir,
      )
      const suggestions = await provider.getSuggestions(["/fr"], 0, 3)
      expect(suggestions).not.toBeNull()
      expect(suggestions!.items.map(item => item.label)).toEqual(["/fresh"])

      // And it resolves and expands from disk.
      expect(resolveSlashInput(dir, "fresh")).toEqual({ kind: "template", content: "Fresh body" })

      // Removing it takes it out of discovery as well.
      rmSync(join(dir, ".minicode", "prompts", "fresh.md"))
      expect(listPromptTemplates(dir).map(t => t.name)).not.toContain("fresh")
      expect(resolveSlashInput(dir, "fresh")).toEqual({ kind: "unknown" })
      const afterRemoval = await provider.getSuggestions(["/fr"], 0, 3)
      expect(afterRemoval).toBeNull()
    })
  })

  test("editing a template is reflected on the next resolution", async () => {
    await withProject(async dir => {
      writeTemplate(dir, "review", "first version")
      expect(resolveSlashInput(dir, "review")).toEqual({ kind: "template", content: "first version" })
      writeTemplate(dir, "review", "second version")
      expect(resolveSlashInput(dir, "review")).toEqual({ kind: "template", content: "second version" })
    })
  })

  test("commands take precedence over a same-named template", async () => {
    await withProject(async dir => {
      writeTemplate(dir, "help", "templated help")
      writeTemplate(dir, "model", "templated model")
      for (const name of ["help", "model"]) {
        expect(resolveSlashInput(dir, name).kind).toBe("command")
        expect(findCommand(name)).toBeDefined()
      }
      expect(resolveSlashInput(dir, "definitely-not-a-command")).toEqual({ kind: "unknown" })
    })
  })

  test("global (user) templates are discovered and resolved", async () => {
    await withProject(async (dir, userDir) => {
      writeTemplate(userDir, "daily", "Daily body", "user")
      expect(listPromptTemplates(dir)).toContainEqual({ name: "daily", source: "user" })
      expect(resolveSlashInput(dir, "daily")).toEqual({ kind: "template", content: "Daily body" })
    })
  })

  test("project templates take precedence over user templates of the same name", async () => {
    await withProject(async (dir, userDir) => {
      writeTemplate(dir, "shared", "project body", "project")
      writeTemplate(userDir, "shared", "user body", "user")
      // Invocation prefers project, matching the historical readTemplate order.
      expect(resolveSlashInput(dir, "shared")).toEqual({ kind: "template", content: "project body" })
    })
  })

  test("autocomplete lists commands alongside live templates", async () => {
    await withProject(async dir => {
      writeTemplate(dir, "review", "Review.")
      const items = autocompleteItems(dir)
      expect(items).toContainEqual({ name: "help", description: findCommand("help")!.description })
      expect(items).toContainEqual({ name: "review", description: "template · project" })
      expect(items.filter(item => item.name === "review")).toHaveLength(1)
      // Every command is still offered.
      for (const command of COMMANDS) {
        expect(items).toContainEqual({ name: command.name, description: command.description })
      }
    })
  })
})
