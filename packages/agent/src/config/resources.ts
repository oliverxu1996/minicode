import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Project/user resources: prompt templates and skills.
 *
 * - Global resources live under `<XDG_CONFIG_HOME>/minicode/` and always load.
 * - Project resources live under `<cwd>/.minicode/` and load only after the
 *   project has been trusted (`/trust`), because their content reaches the
 *   model and can direct the agent to execute commands.
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
  /** Project resources that were skipped because the project is untrusted. */
  untrustedProjectResources: boolean
}

export function userResourceDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(base, "minicode")
}

export function projectResourceDir(cwd: string): string {
  return join(cwd, ".minicode")
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

/** Loads resources with the project-trust gate. `trusted` comes from the
 *  persisted project-trust decision (see trust.ts). */
export function loadResources(cwd: string, trusted: boolean): LoadedResources {
  const result: LoadedResources = { prompts: [], skills: [], untrustedProjectResources: false }

  const userDir = userResourceDir()
  for (const file of readMdFiles(join(userDir, "prompts"))) {
    result.prompts.push({ ...file, source: "user" })
  }
  result.skills.push(...readSkillDirs(join(userDir, "skills")))

  const projectPrompts = join(projectResourceDir(cwd), "prompts")
  const projectSkills = join(projectResourceDir(cwd), "skills")
  const hasProjectResources =
    existsSync(projectPrompts) && readMdFiles(projectPrompts).length > 0 ||
    existsSync(projectSkills) && readSkillDirs(projectSkills).length > 0

  if (hasProjectResources && !trusted) {
    result.untrustedProjectResources = true
    return result
  }

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
