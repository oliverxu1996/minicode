import { createTwoFilesPatch } from "diff"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import type { Tool, ToolExecutionContext, ToolResult } from "./types"
import { resolveToolPath } from "./types"

const UTF8_BOM = "﻿"

export const writeTool: Tool = {
  description:
    "Write content to a file, creating it (and parent directories) if needed. " +
    "Overwrites the whole file — use edit for targeted changes to existing files.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Path to the file to write (absolute, or relative to the workspace)" },
      content: { type: "string", description: "The full content to write" },
    },
    required: ["filePath", "content"],
  },

  async execute(input: unknown, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { filePath, content } = input as { filePath?: string; content?: string }
    if (typeof filePath !== "string" || filePath.length === 0) {
      return { ok: false, error: "Missing filePath parameter" }
    }
    if (typeof content !== "string") {
      return { ok: false, error: "Missing content parameter" }
    }

    const filepath = resolveToolPath(filePath, ctx?.cwd)
    if (await isDirectory(filepath)) {
      return { ok: false, error: `${filepath} is a directory, not a file.` }
    }

    let oldContent = ""
    let hasBom = false
    let existed = false
    try {
      const file = Bun.file(filepath)
      existed = await file.exists()
      if (existed) {
        const text = await file.text()
        hasBom = text.startsWith(UTF8_BOM)
        oldContent = hasBom ? text.slice(UTF8_BOM.length) : text
      }
    } catch (err) {
      return { ok: false, error: `Error reading ${filepath}: ${err instanceof Error ? err.message : err}` }
    }

    try {
      await fs.mkdir(path.dirname(filepath), { recursive: true })
      await Bun.write(filepath, hasBom ? UTF8_BOM + content : content)
    } catch (err) {
      return { ok: false, error: `Error writing ${filepath}: ${err instanceof Error ? err.message : err}` }
    }

    if (!existed) return { ok: true, data: `Created ${filepath}` }
    const diff = createTwoFilesPatch(filepath, filepath, oldContent, content) ?? "No differences found"
    return { ok: true, data: diff }
  },
}

async function isDirectory(filepath: string): Promise<boolean> {
  try {
    const stat = await Bun.file(filepath).stat()
    return Boolean((stat as { isDirectory?: () => boolean }).isDirectory?.())
  } catch {
    return false
  }
}
