import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { configDir } from "./dir"

/**
 * Project/user resources: prompt templates and skills.
 *
 * - Global resources live under `~/.loongcode/` and always load.
 * - Project resources live under `<cwd>/.loongcode/` and always load.
 */

export interface PromptTemplate {
  /** Invocation name (file name without .md). */
  readonly name: string
  readonly content: string
  readonly source: "user" | "project"
}

export interface Skill {
  readonly name: string
  readonly description: string
  /** Full SKILL.md content, returned to the model when invoked. */
  readonly content: string
  readonly source: "user" | "project"
}

export interface LoadedResources {
  prompts: PromptTemplate[]
  skills: Skill[]
}

export function userResourceDir(): string {
  return configDir()
}

export function projectResourceDir(cwd: string): string {
  return join(cwd, ".loongcode")
}

/** A prompt template's identity without its content. */
export interface PromptTemplateSummary {
  readonly name: string
  readonly source: "user" | "project"
}

/**
 * Lists prompt templates by name only, from the user then project directories.
 * Reads directory entries, never file contents, so callers can discover
 * templates cheaply (autocomplete, invocation). Order matches `loadResources`.
 */
export function listPromptTemplates(cwd: string): PromptTemplateSummary[] {
  const out: PromptTemplateSummary[] = []
  const collect = (dir: string, source: "user" | "project"): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      out.push({ name: entry.name.replace(/\.md$/, ""), source })
    }
  }
  collect(join(userResourceDir(), "prompts"), "user")
  collect(join(projectResourceDir(cwd), "prompts"), "project")
  return out
}

function readMdFiles(dir: string): Array<{ name: string; content: string }> {
  if (!existsSync(dir)) return []
  const out: Array<{ name: string; content: string }> = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue
    try {
      out.push({ name: entry.replace(/\.md$/, ""), content: readFileSync(join(dir, entry), "utf-8") })
    } catch {
      // Unreadable file — skip.
    }
  }
  return out
}

function readSkillDirs(root: string): Skill[] {
  if (!existsSync(root)) return []
  const out: Skill[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = join(root, entry.name, "SKILL.md")
    if (!existsSync(skillFile)) continue
    try {
      const content = readFileSync(skillFile, "utf-8")
      const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? entry.name
      out.push({ name: entry.name, description, content, source: "user" })
    } catch {
      // Unreadable — skip.
    }
  }
  return out
}

/** Loads global and project resources. Project-local resources (.loongcode/
 *  prompts and skills) load unconditionally. */
export function loadResources(cwd: string): LoadedResources {
  const result: LoadedResources = { prompts: [], skills: [] }

  const userDir = userResourceDir()
  for (const file of readMdFiles(join(userDir, "prompts"))) {
    result.prompts.push({ ...file, source: "user" })
  }
  result.skills.push(...readSkillDirs(join(userDir, "skills")))

  const projectPrompts = join(projectResourceDir(cwd), "prompts")
  const projectSkills = join(projectResourceDir(cwd), "skills")

  for (const file of readMdFiles(projectPrompts)) {
    result.prompts.push({ ...file, source: "project" })
  }
  for (const skill of readSkillDirs(projectSkills)) {
    result.skills.push({ ...skill, source: "project" })
  }
  return result
}

/** Skills formatted for the system prompt (list with a
 *  "load this skill" instruction carried by the description). */
export function formatSkillPrompt(skills: Skill[]): string {
  if (skills.length === 0) return ""
  const lines = skills.map(skill => `- ${skill.name}: ${skill.description}`)
  return [
    "<available_skills>",
    "The following skills are available. Use the skill tool with the skill name to load one before acting on it.",
    ...lines,
    "</available_skills>",
  ].join("\n")
}
