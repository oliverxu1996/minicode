import type { ModelMessage, ModelToolResult } from "@minicode/model"

const PRESERVE_TURNS = 2
const CAP_BYTES = 40 * 1024
const PLACEHOLDER = "[Old tool result content cleared]"

/**
 * Serialization-time history shrink: tool outputs older than the last two
 * user turns are replaced by a placeholder, and the preserved region's
 * outputs are capped at 40KB cumulative. Tool errors are always preserved
 * (they carry the signal a repair loop needs).
 *
 * Applied to the request copy only — durable history is never rewritten.
 */
export function pruneOldToolOutputs(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages

  const userIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i)
  }
  if (userIndices.length <= PRESERVE_TURNS) return messages

  const preserveStart = userIndices[userIndices.length - PRESERVE_TURNS]

  let cumulative = 0
  return messages.map((message, i) => {
    if (message.role !== "tool") return message

    let changed = false
    const content: ModelToolResult[] = (message.content as ModelToolResult[]).map(result => {
      // Errors are preserved — they are the repair loop's signal.
      if (result.output.type === "tool_error") return result
      if (result.output.type !== "text") return result
      if (result.output.text === PLACEHOLDER) return result

      if (i < preserveStart) {
        changed = true
        return { ...result, output: { type: "text" as const, text: PLACEHOLDER } }
      }

      cumulative += Buffer.byteLength(result.output.text, "utf-8")
      if (cumulative > CAP_BYTES) {
        changed = true
        return { ...result, output: { type: "text" as const, text: PLACEHOLDER } }
      }
      return result
    })

    return changed ? { ...message, content } : message
  })
}
