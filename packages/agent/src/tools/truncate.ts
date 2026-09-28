import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolResult } from "./types"

const THRESHOLD = 2048
const PREVIEW_LENGTH = 500

function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

/**
 * Caps any successful tool output at THRESHOLD bytes: larger outputs spill
 * to `<cwd>/.tool-output/<tool>-<hash>.txt` and the model receives a
 * preview plus a pointer it can `read` with offset/limit.
 */
export function truncateOutput(result: ToolResult, cwd: string, toolName?: string): ToolResult {
  if (!result.ok) return result
  if (result.data.length <= THRESHOLD) return result

  const slug = `${toolName ?? "tool"}-${hash(result.data)}.txt`
  const dir = join(cwd, ".tool-output")
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, slug), result.data, "utf-8")
  } catch {
    // Spilling is best-effort; fall through to hard truncation.
    return {
      ...result,
      ok: true,
      data: `${result.data.slice(0, THRESHOLD)}\n\n...[${result.data.length - THRESHOLD} bytes truncated]`,
    }
  }

  const preview = result.data.slice(0, PREVIEW_LENGTH)
  const truncated = result.data.length - PREVIEW_LENGTH
  return {
    ...result,
    ok: true,
    data: `${preview}\n\n...${truncated} bytes truncated. Full content saved to: ${join(dir, slug)}\nUse read with offset/limit to view specific sections.`,
  }
}
