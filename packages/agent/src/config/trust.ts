import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { projectSettingsPath } from "./settings"

/**
 * Project trust: project-local resources (.minicode/prompts, .minicode/
 * skills) can direct the agent to execute commands, so they are
 * gated behind an explicit per-project trust decision, persisted in the
 * project settings file.
 */
export function isProjectTrusted(cwd: string): boolean {
  const path = projectSettingsPath(cwd)
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { projectTrusted?: unknown }
    return parsed.projectTrusted === true
  } catch {
    return false
  }
}

/** Persists the trust decision in the project settings file. */
export function trustProject(cwd: string): void {
  const path = projectSettingsPath(cwd)
  let settings: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
    } catch {
      settings = {}
    }
  }
  settings.projectTrusted = true
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8")
}
