import { readdir } from "node:fs/promises"
import * as path from "node:path"
import type { Tool, ToolExecutionContext, ToolResult } from "./types"
import { resolveToolPath } from "./types"

const MAX_RESULTS = 200
const IGNORED_DIRS = new Set([".git", "node_modules", ".tool-output", ".minicode"])

export const findTool: Tool = {
  idempotent: true,
  description:
    'Find files by glob pattern (e.g. "*.ts", "src/**/*.json") below a directory. ' +
    "Skips .git and node_modules.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern matched against paths relative to the search directory" },
      path: { type: "string", description: "Directory to search in. Defaults to the workspace root." },
    },
    required: ["pattern"],
  },

  async execute(input: unknown, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { pattern: glob, path: searchDir } = input as { pattern?: string; path?: string }
    if (typeof glob !== "string" || glob.length === 0) {
      return { ok: false, error: "pattern is required" }
    }

    const root = searchDir !== undefined && searchDir !== ""
      ? resolveToolPath(searchDir, ctx?.cwd)
      : ctx?.cwd ?? process.cwd()
    const globber = new Bun.Glob(glob)
    const results: string[] = []

    const walk = async (dirPath: string, relBase: string): Promise<void> => {
      if (results.length >= MAX_RESULTS) return
      let entries
      try {
        entries = await readdir(dirPath, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) return
        const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue
          await walk(path.join(dirPath, entry.name), rel)
        } else if (globber.match(rel)) {
          results.push(rel)
        }
      }
    }

    await walk(root, "")
    if (results.length === 0) return { ok: true, data: "No files found." }
    const suffix = results.length >= MAX_RESULTS ? `\n\n(Limited to ${MAX_RESULTS} results.)` : ""
    return { ok: true, data: results.join("\n") + suffix }
  },
}
