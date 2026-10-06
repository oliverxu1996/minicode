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
 * Caps tool output at THRESHOLD bytes: larger outputs spill to
 * `<cwd>/.tool-output/<tool>-<hash>.txt` and the model receives a preview plus
 * a pointer it can `read` with offset/limit.
 *
 * This is the canonical boundary and it is unconditional. `ok` decides where
 * the bounded text lives (`data` or `error`), never whether it is bounded: a
 * failed execution — a command that timed out after accumulating large partial
 * output, say — reaches durable history through the same cap as a successful
 * one. Failure semantics are untouched: `ok` stays false, the diagnostic head
 * survives in the preview, and the full text is recoverable from the prose
 * pointer. `failureEvidence` on a successful result is preserved.
 */
export function truncateOutput(result: ToolResult, cwd: string, toolName?: string): ToolResult {
  const text = result.ok ? result.data : result.error
  if (text.length <= THRESHOLD) return result

  const slug = `${toolName ?? "tool"}-${hash(text)}.txt`
  const dir = join(cwd, ".tool-output")
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, slug), text, "utf-8")
  } catch {
    // Spilling is best-effort; fall through to hard truncation.
    const head = `${text.slice(0, THRESHOLD)}\n\n...[${text.length - THRESHOLD} bytes truncated]`
    return result.ok ? { ...result, data: head } : { ...result, error: head }
  }

  const preview = text.slice(0, PREVIEW_LENGTH)
  const truncated = text.length - PREVIEW_LENGTH
  const spillPath = join(dir, slug)
  const capped = `${preview}\n\n...${truncated} bytes truncated. Full content saved to: ${spillPath}\nUse read with offset/limit to view specific sections.`
  return result.ok
    ? {
        ...result,
        data: capped,
        // The same fact the sentence states, declared structurally so
        // request-time pruning does not have to recognise this wording.
        affordances: { ...result.affordances, externalizedAt: spillPath },
      }
    // A failure has no structured affordance (never reduced by pruning); its
    // prose pointer is the recovery surface.
    : { ...result, error: capped }
}
