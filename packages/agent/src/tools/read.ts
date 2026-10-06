import { readdir } from "node:fs/promises"
import * as path from "node:path"
import type { Tool, ToolExecutionContext, ToolResult } from "./types"
import { resolveToolPath } from "./types"
import { levenshtein } from "./levenshtein"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class",
  ".jar", ".war", ".7z", ".doc", ".docx", ".xls", ".xlsx",
  ".ppt", ".pptx", ".odt", ".ods", ".odp", ".bin", ".dat",
  ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo",
])

export const readTool: Tool = {
  idempotent: true,
  description:
    "Read a text file (with line numbers) or list a directory. " +
    "Reads up to 2000 lines / 50KB per call; use offset/limit to page through larger files.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Path to the file or directory to read (absolute, or relative to the workspace)" },
      offset: { type: "integer", minimum: 1, default: 1, description: "Line number to start reading from (1-indexed)" },
      limit: { type: "integer", minimum: 1, default: 2000, description: "Maximum number of lines to read" },
    },
    required: ["filePath"],
  },

  execute(input: unknown, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { filePath, offset, limit } = input as {
      filePath?: string
      offset?: number
      limit?: number
    }
    if (typeof filePath !== "string" || filePath.length === 0) {
      return Promise.resolve({ ok: false, error: "Missing filePath parameter" })
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
      return Promise.resolve({ ok: false, error: "offset must be a positive integer" })
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return Promise.resolve({ ok: false, error: "limit must be a positive integer" })
    }
    return executeRead(
      filePath,
      { offset: offset ?? 1, limit: limit ?? DEFAULT_READ_LIMIT },
      ctx,
    )
  },
}

async function executeRead(
  filePath: string,
  opts: { offset: number; limit: number },
  ctx?: ToolExecutionContext,
): Promise<ToolResult> {
  const filepath = resolveToolPath(filePath, ctx?.cwd)

  const stat = await statPath(filepath)
  if (!stat) return miss(filepath)
  if (stat.isDirectory()) return listDirectory(filepath, opts)

  const content = await readFileContent(filepath, stat, opts)
  if (!content.ok) return content.error
  return formatFileOutput(filepath, content.value)
}

async function statPath(filepath: string): Promise<{ size: number; isDirectory: () => boolean } | null> {
  try {
    return await Bun.file(filepath).stat()
  } catch {
    return null
  }
}

/** Not-found with suggestions: score sibling entries by edit distance so a
 *  mistyped path is immediately correctable by the model. */
async function miss(filepath: string): Promise<ToolResult> {
  const dir = path.dirname(filepath)
  const base = path.basename(filepath).toLowerCase()

  let items: string[] = []
  try {
    const entries = await readdir(dir)
    const scored = entries
      .map(item => {
        const itemLower = item.toLowerCase()
        const dist = levenshtein(base, itemLower)
        const isSubstring = itemLower.includes(base) || base.includes(itemLower)
        return { item, dist, isSubstring }
      })
      .filter(({ dist, isSubstring }) => {
        const maxLen = Math.max(base.length, dist)
        if (maxLen === 0) return false
        return isSubstring || dist <= Math.min(3, Math.ceil(maxLen * 0.5))
      })
      .sort((a, b) => a.dist - b.dist || a.item.localeCompare(b.item))
      .map(({ item }) => path.join(dir, item))
      .slice(0, 3)
    items = scored
  } catch {
    // Parent unreadable — plain not-found.
  }

  if (items.length > 0) {
    return { ok: false, error: `File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}` }
  }
  return { ok: false, error: `File not found: ${filepath}` }
}

async function listDirectory(filepath: string, opts: { offset: number; limit: number }): Promise<ToolResult> {
  try {
    const entries = await readdir(filepath, { withFileTypes: true })
    const items = await Promise.all(
      entries.map(async entry => {
        if (entry.isDirectory()) return entry.name + "/"
        if (entry.isSymbolicLink()) {
          try {
            const target = await Bun.file(path.join(filepath, entry.name)).stat()
            if (target.isDirectory()) return entry.name + "/"
          } catch {
            // Broken symlink — show as file.
          }
        }
        return entry.name
      }),
    )

    const sorted = items.sort((a, b) => a.localeCompare(b))
    const start = opts.offset - 1
    const sliced = sorted.slice(start, start + opts.limit)
    const truncated = start + sliced.length < sorted.length

    return {
      ok: true,
      data: [
        `<path>${filepath}</path>`,
        `<type>directory</type>`,
        `<entries>`,
        sliced.join("\n"),
        truncated
          ? `\n(Showing ${sliced.length} of ${sorted.length} entries. Use offset=${opts.offset + sliced.length} to continue.)`
          : `\n(${sorted.length} entries)`,
        `</entries>`,
      ].join("\n"),
      ...(truncated ? { affordances: { resumeOffset: opts.offset + sliced.length } } : {}),
    }
  } catch (err) {
    return { ok: false, error: `Error listing directory ${filepath}: ${err instanceof Error ? err.message : err}` }
  }
}

async function readFileContent(
  filepath: string,
  stat: { size: number },
  opts: { offset: number; limit: number },
): Promise<{ ok: true; value: Awaited<ReturnType<typeof readLines>> } | { ok: false; error: ToolResult }> {
  let sample: Uint8Array
  try {
    if (stat.size === 0) {
      sample = new Uint8Array()
    } else {
      const sliced = Bun.file(filepath).slice(0, Math.min(SAMPLE_BYTES, stat.size))
      sample = new Uint8Array(await sliced.arrayBuffer())
    }
  } catch (err) {
    return { ok: false, error: { ok: false, error: `Error reading ${filepath}: ${err instanceof Error ? err.message : err}` } }
  }

  if (isBinaryFile(filepath, sample)) {
    return { ok: false, error: { ok: false, error: `Cannot read binary file: ${filepath}` } }
  }

  try {
    return { ok: true, value: await readLines(filepath, opts) }
  } catch (err) {
    return { ok: false, error: { ok: false, error: `Error reading ${filepath}: ${err instanceof Error ? err.message : err}` } }
  }
}

async function readLines(
  filepath: string,
  opts: { offset: number; limit: number },
): Promise<{ raw: string[]; count: number; cut: boolean; more: boolean; offset: number }> {
  const start = opts.offset - 1
  const raw: string[] = []
  let bytes = 0
  let count = 0
  let cut = false
  let more = false

  const text = await Bun.file(filepath).text()
  if (!text) return { raw, count: 0, cut: false, more: false, offset: opts.offset }
  const allLines = text.split("\n")
  if (text.endsWith("\n")) allLines.pop()

  for (const line of allLines) {
    count += 1
    if (count <= start) continue
    if (raw.length >= opts.limit) {
      more = true
      break
    }

    const truncated = line.length > MAX_LINE_LENGTH
      ? line.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
      : line
    const size = Buffer.byteLength(truncated, "utf-8") + (raw.length > 0 ? 1 : 0)
    if (bytes + size > MAX_BYTES) {
      cut = true
      more = true
      break
    }

    raw.push(truncated)
    bytes += size
  }

  return { raw, count, cut, more, offset: opts.offset }
}

function isBinaryFile(filepath: string, bytes: Uint8Array): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(filepath).toLowerCase())) return true
  if (bytes.length === 0) return false

  const len = Math.min(bytes.length, SAMPLE_BYTES)
  let nonPrintable = 0
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) nonPrintable++
  }
  return nonPrintable / len > 0.3
}

function formatFileOutput(
  filepath: string,
  result: Awaited<ReturnType<typeof readLines>>,
): ToolResult {
  const next = result.offset + result.raw.length
  let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
  output += result.raw.map((line, i) => `${i + result.offset}: ${line}`).join("\n")

  const lastLine = result.offset + result.raw.length - 1
  if (result.cut) {
    output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${result.offset}-${lastLine}. Use offset=${next} to continue.)`
  } else if (result.more) {
    output += `\n\n(Showing lines ${result.offset}-${lastLine}. Use offset=${next} to continue.)`
  } else {
    output += `\n\n(End of file - total ${result.count} lines)`
  }
  output += "\n</content>"

  // The same continuation the sentence offers, declared structurally so
  // request-time pruning does not have to recognise this wording.
  return result.cut || result.more
    ? { ok: true, data: output, affordances: { resumeOffset: next } }
    : { ok: true, data: output }
}
