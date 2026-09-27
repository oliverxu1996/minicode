import type { ModelTool } from "@minicode/model"
import type { Tool } from "./types"
import { bashTool } from "./bash"
import { editTool } from "./edit"
import { findTool } from "./find"
import { grepTool } from "./grep"
import { lsTool } from "./ls"
import { readTool } from "./read"
import { writeTool } from "./write"

/**
 * The fixed MiniCode v0.1 coding toolset: the seven tools a coding agent
 * needs to explore, modify, and verify a repository.
 */
export const CODING_TOOLS: ReadonlyMap<string, Tool> = new Map([
  ["read", readTool],
  ["write", writeTool],
  ["edit", editTool],
  ["grep", grepTool],
  ["find", findTool],
  ["ls", lsTool],
  ["bash", bashTool],
])

/** The toolset as `@minicode/model` tool definitions, for a ModelRequest. */
export function toModelTools(tools: ReadonlyMap<string, Tool>): ModelTool[] {
  return [...tools.entries()].map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}

export type { Tool, ToolResult, ToolExecutionContext } from "./types"
