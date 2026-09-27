import * as path from "node:path"
import type { Tool, ToolExecutionContext, ToolResult } from "./types"
import { resolveToolPath } from "./types"

const MAX_LINE_LENGTH = 2000
const MAX_MATCHES = 100

export const grepTool: Tool = {
  idempotent: true,
  description:
    "Search file contents with a regular expression (POSIX extended regex, case-insensitive). " +
    "Returns matching lines with file:line prefixes. Skips binary files.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regular expression to search for" },
      path: { type: "string", description: "Directory or file to search in. Defaults to the workspace root." },
      include: { type: "string", description: 'Glob pattern to filter searched files, e.g. "*.ts"' },
    },
    required: ["pattern"],
  },

  async execute(input: unknown, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { pattern, path: searchPath, include } = input as {
      pattern?: string
      path?: string
      include?: string
    }
    if (typeof pattern !== "string" || pattern.length === 0) {
      return { ok: false, error: "pattern is required" }
    }

    let target = searchPath !== undefined && searchPath !== ""
      ? resolveToolPath(searchPath, ctx?.cwd)
      : ctx?.cwd ?? process.cwd()

    // A file target: search within its directory but only that file.
    let fileArgs: string[] = []
    const stat = await Bun.file(target).stat().catch(() => null)
    if (stat && !stat.isDirectory()) {
      fileArgs = [target]
      target = path.dirname(target)
    }

    const args = [
      "grep", "-rniIE",
      ...(include !== undefined && include !== "" ? [`--include=${include}`] : []),
      "--",
      pattern,
      ...fileArgs,
      ...(fileArgs.length > 0 ? [] : [target]),
    ]

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: ctx?.cwd,
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited

    if (exitCode === 1) return { ok: true, data: "No matches found." }
    if (exitCode !== 0) {
      return { ok: false, error: `grep failed (exit ${exitCode}): ${stderr.trim().slice(0, 500)}` }
    }

    const lines = stdout.split("\n").filter(line => line.length > 0)
    if (lines.length === 0) return { ok: true, data: "No matches found." }

    const total = lines.length
    const capped = lines.slice(0, MAX_MATCHES).map(line =>
      line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + "..." : line
    )
    const suffix = total > MAX_MATCHES
      ? `\n\n(Showing ${MAX_MATCHES} of ${total} matches. Refine the pattern or narrow the path.)`
      : ""
    return { ok: true, data: capped.join("\n") + suffix }
  },
}
