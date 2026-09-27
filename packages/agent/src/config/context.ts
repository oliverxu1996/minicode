import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface ProjectContextFile {
  readonly path: string
  readonly content: string
}

/**
 * Project instruction files, in precedence order: the first existing
 * candidate in the workspace root wins. Content is injected into the system
 * prompt as `<project_instructions>` so the agent actually receives it.
 */
const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]

export function loadProjectContext(cwd: string): ProjectContextFile | null {
  for (const name of CANDIDATES) {
    const path = join(cwd, name)
    try {
      return { path, content: readFileSync(path, "utf-8") }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

/** Formats loaded context for the system prompt. */
export function formatProjectInstructions(context: ProjectContextFile | null): string | null {
  if (context === null) return null
  return `<project_instructions path="${context.path}">\n${context.content}\n</project_instructions>`
}
