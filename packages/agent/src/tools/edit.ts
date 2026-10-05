import * as path from "node:path"
import { createTwoFilesPatch } from "diff"
import type { Tool, ToolExecutionContext, ToolResult } from "./types"
import { resolveToolPath } from "./types"

export const editTool: Tool = {
  description:
    "Replace an exact text span inside an existing file with new text. " +
    "oldString must match the file content (whitespace-tolerant fallbacks are attempted). " +
    "Refuses when the match is ambiguous unless replaceAll is set. " +
    "Returns a diff of the change.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Path to the file to edit (absolute, or relative to the workspace)" },
      oldString: { type: "string", description: "The exact text to find. Use empty string with newString set to create the file." },
      newString: { type: "string", description: "The text to replace it with" },
      replaceAll: { type: "boolean", default: false, description: "Replace every occurrence instead of requiring a unique match" },
    },
    required: ["filePath", "oldString", "newString"],
  },

  async execute(input: unknown, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { filePath, oldString, newString, replaceAll } = input as {
      filePath?: string
      oldString?: string
      newString?: string
      replaceAll?: boolean
    }
    if (typeof filePath !== "string" || filePath.length === 0) {
      return { ok: false, error: "Missing filePath parameter" }
    }
    if (typeof oldString !== "string" || typeof newString !== "string") {
      return { ok: false, error: "oldString and newString must be strings" }
    }
    return executeEdit(filePath, oldString, newString, replaceAll === true, ctx)
  },
}

async function executeEdit(
  filePathInput: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  ctx?: ToolExecutionContext,
): Promise<ToolResult> {
  if (oldString === newString) {
    return { ok: false, error: "oldString and newString are identical, nothing to change." }
  }

  const filePath = path.isAbsolute(filePathInput)
    ? filePathInput
    : resolveToolPath(filePathInput, ctx?.cwd)

  let content: string
  try {
    const file = Bun.file(filePath)
    const exists = await file.exists()

    if (!exists) {
      if (oldString === "") {
        await Bun.write(filePath, newString)
        return { ok: true, data: `Created ${filePath}` }
      }
      return { ok: false, error: `File not found: ${filePath}` }
    }

    try {
      const stat = await file.stat()
      if ((stat as { isDirectory?: () => boolean }).isDirectory?.()) {
        return { ok: false, error: `${filePath} is a directory, not a file.` }
      }
    } catch {
      // stat may fail; proceed assuming a file.
    }

    content = await file.text()
  } catch (err) {
    return { ok: false, error: `Error reading ${filePath}: ${err instanceof Error ? err.message : err}` }
  }

  for (const [name, replacer] of REPLACERS) {
    const match = replacer(content, oldString, newString)
    if (!match) continue

    if (match.count > 1 && !replaceAll) {
      return {
        ok: false,
        error: `Found ${match.count} occurrences of oldString (using ${name} matching). ` +
          `Use replaceAll:true to replace all, or provide more surrounding context to make the match unique.`,
      }
    }

    const newContent = match.replace(content)
    try {
      await Bun.write(filePath, newContent)
    } catch (err) {
      return { ok: false, error: `Error writing ${filePath}: ${err instanceof Error ? err.message : err}` }
    }

    const diff = createTwoFilesPatch(filePath, filePath, content, newContent) ?? "No differences found"
    return { ok: true, data: diff }
  }

  return {
    ok: false,
    error: `Could not find the specified text in ${filePath}. It must match exactly, including whitespace, indentation, and line endings.`,
  }
}

// ── Replacer cascade ─────────────────────────────────────────────
// Attempted in order; the first strategy that finds a match wins. Fuzzy
// strategies let slightly-imprecise model output still land correctly
// while the ambiguity refusal keeps fuzzy matches safe.

type ReplaceFn = (content: string) => string

interface ReplacerMatch {
  count: number
  replace: ReplaceFn
}

type Replacer = (content: string, oldStr: string, newStr: string) => ReplacerMatch | null

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const prev = new Uint32Array(b.length + 1)
  const curr = new Uint32Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1
    for (let j = 0; j < b.length; j++) {
      curr[j + 1] = a[i] === b[j] ? prev[j] : 1 + Math.min(prev[j], curr[j], prev[j + 1])
    }
    const tmp = prev
    prev.set(curr)
    curr.set(tmp)
  }
  return prev[b.length]
}

function simpleReplacer(content: string, oldStr: string, newStr: string): ReplacerMatch | null {
  let count = 0
  let pos = -1
  while ((pos = content.indexOf(oldStr, pos + 1)) !== -1) count++
  if (count === 0) return null
  return { count, replace: c => c.split(oldStr).join(newStr) }
}

function lineTrimmedReplacer(content: string, oldStr: string, newStr: string): ReplacerMatch | null {
  const contentLines = content.split("\n")
  const oldLines = oldStr.split("\n")
  if (oldLines.length === 0) return null
  const trimmedSearch = oldLines.map(l => l.trimEnd())

  const matches: Array<{ start: number; end: number }> = []
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let ok = true
    for (let j = 0; j < oldLines.length; j++) {
      if (contentLines[i + j].trimEnd() !== trimmedSearch[j]) {
        ok = false
        break
      }
    }
    if (ok) matches.push({ start: i, end: i + oldLines.length - 1 })
  }
  if (matches.length === 0) return null

  return {
    count: matches.length,
    replace: c => {
      const lines = c.split("\n")
      for (let m = matches.length - 1; m >= 0; m--) {
        const { start, end } = matches[m]
        lines.splice(start, end - start + 1, newStr)
      }
      return lines.join("\n")
    },
  }
}

function blockAnchorReplacer(content: string, oldStr: string, newStr: string): ReplacerMatch | null {
  const contentLines = content.split("\n")
  const oldLines = oldStr.split("\n")
  if (oldLines[oldLines.length - 1] === "") oldLines.pop()
  if (oldLines.length < 3) return null

  const firstAnchor = oldLines[0].trimEnd()
  const lastAnchor = oldLines[oldLines.length - 1].trimEnd()

  const matches: Array<{ start: number; end: number }> = []
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trimEnd() !== firstAnchor) continue
    for (let j = i + oldLines.length - 1; j < contentLines.length; j++) {
      if (contentLines[j].trimEnd() === lastAnchor) {
        matches.push({ start: i, end: j })
        break
      }
    }
  }
  if (matches.length === 0) return null

  return {
    count: matches.length,
    replace: c => {
      const ls = c.split("\n")
      for (let m = matches.length - 1; m >= 0; m--) {
        const { start, end } = matches[m]
        ls.splice(start, end - start + 1, newStr)
      }
      return ls.join("\n")
    },
  }
}

function whitespaceNormalizedReplacer(content: string, oldStr: string, newStr: string): ReplacerMatch | null {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim()
  const normOldLines = oldStr.split("\n").map(norm)
  const normContentLines = content.split("\n").map(norm)
  if (oldStr.split("\n").length === 1) return null

  const matches: Array<{ start: number; end: number }> = []
  for (let i = 0; i <= normContentLines.length - normOldLines.length; i++) {
    let ok = true
    for (let j = 0; j < normOldLines.length; j++) {
      if (normContentLines[i + j] !== normOldLines[j]) {
        ok = false
        break
      }
    }
    if (ok) matches.push({ start: i, end: i + normOldLines.length - 1 })
  }
  if (matches.length === 0) return null

  return {
    count: matches.length,
    replace: c => {
      const ls = c.split("\n")
      for (let m = matches.length - 1; m >= 0; m--) {
        ls.splice(matches[m].start, matches[m].end - matches[m].start + 1, newStr)
      }
      return ls.join("\n")
    },
  }
}

function indentationFlexibleReplacer(content: string, oldStr: string, newStr: string): ReplacerMatch | null {
  const lines = content.split("\n")
  const oldLines = oldStr.split("\n")
  if (oldLines.length === 0) return null

  const nonEmpty = oldLines.filter(l => l.trim().length > 0)
  if (nonEmpty.length === 0) return null

  const minIndent = Math.min(...nonEmpty.map(l => {
    const m = l.match(/^(\s*)/)
    return m ? m[1].length : 0
  }))
  const strippedOld = oldLines.map(l => l.trim().length === 0 ? l : l.slice(minIndent))

  const matches: Array<{ start: number; end: number }> = []
  for (let i = 0; i <= lines.length - oldLines.length; i++) {
    const block = lines.slice(i, i + oldLines.length)
    const blockNonEmpty = block.filter(l => l.trim().length > 0)
    const blockMinIndent = blockNonEmpty.length === 0 ? 0 : Math.min(...blockNonEmpty.map(l => {
      const m = l.match(/^(\s*)/)
      return m ? m[1].length : 0
    }))
    const strippedBlock = block.map(l => l.trim().length === 0 ? l : l.slice(blockMinIndent))
    let ok = true
    for (let j = 0; j < oldLines.length; j++) {
      if (strippedBlock[j] !== strippedOld[j]) {
        ok = false
        break
      }
    }
    if (ok) matches.push({ start: i, end: i + oldLines.length - 1 })
  }
  if (matches.length === 0) return null

  return {
    count: matches.length,
    replace: c => {
      const ls = c.split("\n")
      for (let m = matches.length - 1; m >= 0; m--) {
        ls.splice(matches[m].start, matches[m].end - matches[m].start + 1, newStr)
      }
      return ls.join("\n")
    },
  }
}

function escapeNormalizedReplacer(content: string, oldStr: string, newStr: string): ReplacerMatch | null {
  const unescape = (s: string): string => {
    return s.replace(/\\([ntr'"`\\$])/g, (_, c) => {
      switch (c) {
        case "n": return "\n"
        case "t": return "\t"
        case "r": return "\r"
        default: return c
      }
    })
  }
  const unescapedOld = unescape(oldStr)
  const unescapedNew = unescape(newStr)
  if (unescapedOld === oldStr) return null

  if (content.includes(unescapedOld)) {
    let count = 0
    let pos = -1
    while ((pos = content.indexOf(unescapedOld, pos + 1)) !== -1) count++
    return { count, replace: c => c.split(unescapedOld).join(unescapedNew) }
  }
  return null
}

function trimmedBoundaryReplacer(content: string, oldStr: string, newStr: string): ReplacerMatch | null {
  const trimmed = oldStr.trim()
  if (trimmed === oldStr) return null
  return simpleReplacer(content, trimmed, newStr)
}

function contextAwareReplacer(content: string, oldStr: string, newStr: string): ReplacerMatch | null {
  const contentLines = content.split("\n")
  const oldLines = oldStr.split("\n")
  if (oldLines[oldLines.length - 1] === "") oldLines.pop()
  if (oldLines.length < 3) return null

  const firstAnchor = oldLines[0].trimEnd()
  const lastAnchor = oldLines[oldLines.length - 1].trimEnd()

  const candidates: Array<{ start: number; end: number; score: number }> = []
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trimEnd() !== firstAnchor) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trimEnd() !== lastAnchor) continue
      const blockLines = contentLines.slice(i, j + 1)
      let matchCount = 0
      let total = 0
      for (let k = 1; k < blockLines.length - 1 && k < oldLines.length - 1; k++) {
        const bl = blockLines[k].trimEnd()
        const ol = oldLines[k].trimEnd()
        if (bl.length > 0 || ol.length > 0) {
          total++
          const maxLen = Math.max(bl.length, ol.length)
          const sim = maxLen === 0 ? 1 : 1 - levenshtein(bl, ol) / maxLen
          if (sim >= 0.5) matchCount++
        }
      }
      if (total === 0 || matchCount / total >= 0.5) {
        const sizeDiff = Math.abs(blockLines.length - oldLines.length)
        candidates.push({ start: i, end: j, score: -sizeDiff })
      }
      break
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score)

  // Report how many distinct places the edit would land. Hardcoding 1 here made
  // the caller's ambiguity guard unreachable, so an ambiguous fuzzy match was
  // replaced silently at the best-scoring candidate — the opposite of the
  // documented "refuse when ambiguous". The count is the guard's only input.
  //
  // Two candidates can describe overlapping regions (a later first-anchor may
  // sit inside an earlier candidate's block). Those are one place, not two, so
  // they are collapsed before counting; the best-scoring interpretation wins.
  const chosen: Array<{ start: number; end: number }> = []
  for (const candidate of candidates) {
    const overlaps = chosen.some(o => candidate.start <= o.end && o.start <= candidate.end)
    if (!overlaps) chosen.push({ start: candidate.start, end: candidate.end })
  }
  chosen.sort((a, b) => a.start - b.start)

  return {
    count: chosen.length,
    replace: c => {
      const ls = c.split("\n")
      // Backwards so each splice leaves the earlier indices valid.
      for (let m = chosen.length - 1; m >= 0; m--) {
        ls.splice(chosen[m].start, chosen[m].end - chosen[m].start + 1, newStr)
      }
      return ls.join("\n")
    },
  }
}

const REPLACERS: Array<[string, Replacer]> = [
  ["exact", simpleReplacer],
  ["line-trimmed", lineTrimmedReplacer],
  ["block-anchor", blockAnchorReplacer],
  ["whitespace-normalized", whitespaceNormalizedReplacer],
  ["indentation-flexible", indentationFlexibleReplacer],
  ["escape-normalized", escapeNormalizedReplacer],
  ["trimmed-boundary", trimmedBoundaryReplacer],
  ["context-aware", contextAwareReplacer],
]
