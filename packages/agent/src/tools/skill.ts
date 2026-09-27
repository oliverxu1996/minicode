import type { Tool, ToolResult } from "./types"
import type { Skill } from "../config/resources"

/**
 * Loads a skill's SKILL.md content into the conversation. Listed in the
 * system prompt (<available_skills>) so the model knows when to invoke one.
 */
export function createSkillTool(skills: Skill[]): Tool {
  return {
    idempotent: true,
    description:
      "Load a skill's full instructions into the conversation. " +
      `Available skills: ${skills.map(s => s.name).join(", ") || "(none)"}.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill name to load" },
      },
      required: ["name"],
    },
    execute(input: unknown): ToolResult {
      const { name } = input as { name?: string }
      if (typeof name !== "string" || name.length === 0) {
        return { ok: false, error: "Missing name parameter" }
      }
      const skill = skills.find(s => s.name === name)
      if (skill === undefined) {
        return {
          ok: false,
          error: `unknown skill "${name}". Available: ${skills.map(s => s.name).join(", ") || "(none)"}`,
        }
      }
      return { ok: true, data: skill.content }
    },
  }
}
