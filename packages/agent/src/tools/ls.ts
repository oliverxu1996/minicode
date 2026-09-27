import { readdir } from "node:fs/promises"
import * as path from "node:path"
import type { Tool, ToolExecutionContext, ToolResult } from "./types"
import { resolveToolPath } from "./types"

export const lsTool: Tool = {
  idempotent: true,
  description: "List the entries of a directory. Directories get a trailing slash.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list. Defaults to the workspace root." },
    },
  },

  async execute(input: unknown, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { path: listPath } = input as { path?: string }
    const target = listPath !== undefined && listPath !== ""
      ? resolveToolPath(listPath, ctx?.cwd)
      : ctx?.cwd ?? process.cwd()

    try {
      const entries = await readdir(target, { withFileTypes: true })
      const items = await Promise.all(entries.map(async entry => {
        if (entry.isDirectory()) return entry.name + "/"
        if (entry.isSymbolicLink()) {
          try {
            const stat = await Bun.file(path.join(target, entry.name)).stat()
            if (stat.isDirectory()) return entry.name + "/"
          } catch {
            // Broken symlink — show as file.
          }
        }
        return entry.name
      }))
      if (items.length === 0) return { ok: true, data: "(empty directory)" }
      return { ok: true, data: items.sort((a, b) => a.localeCompare(b)).join("\n") }
    } catch (err) {
      return { ok: false, error: `Cannot list ${target}: ${err instanceof Error ? err.message : err}` }
    }
  },
}
