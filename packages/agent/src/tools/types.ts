/**
 * Result of a single tool execution.
 *
 * Errors are data: a failed tool returns `ok: false` and the runtime hands
 * the message to the model, which decides how to react. Tool failures never
 * terminate a run by themselves.
 */
export type ToolResult =
  | { readonly ok: true; readonly data: string }
  | { readonly ok: false; readonly error: string }

/** Per-invocation context supplied by the runtime. */
export interface ToolExecutionContext {
  /** Durable id of this invocation (matches the ledger and history). */
  readonly toolCallId?: string
  /** Session workspace root; relative tool paths resolve against it. */
  readonly cwd?: string
  /** The run's cancellation signal. Long-running tools should honor it so
   *  an aborted run does not wait for a hanging command. */
  readonly signal?: AbortSignal
  /** Streaming output callback for long-running tools (e.g. bash chunks).
   *  The runtime forwards it to the UI as tool progress. */
  readonly onOutput?: (text: string) => void
}

/**
 * A coding tool.
 *
 * `inputSchema` is a JSON Schema object handed to the model verbatim via
 * `@minicode/model`. Tools validate their own input defensively — a schema
 * constraint violation by the model surfaces as an `ok: false` result, not
 * a thrown error.
 */
export interface Tool {
  readonly description: string
  readonly inputSchema: Record<string, unknown>

  execute(input: unknown, ctx?: ToolExecutionContext): ToolResult | Promise<ToolResult>

  /** True when re-executing after an interrupted run with unknown outcome
   *  is safe (read-only tools). Defaults to false: unknown outcomes must
   *  never be blindly retried. */
  readonly idempotent?: boolean
}

/** Resolves a tool input path against the session cwd when relative. */
export function resolveToolPath(filepath: string, cwd?: string): string {
  let resolved = filepath
  if (!resolved.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(resolved)) {
    resolved = `${cwd ?? process.cwd()}/${resolved}`.replace(/\/\.{1,2}\//g, "/")
    resolved = normalizePath(resolved)
  }
  return resolved
}

/** Resolves `.`/`..` segments without touching the filesystem. */
function normalizePath(p: string): string {
  const parts = p.split("/")
  const out: string[] = []
  for (const part of parts) {
    if (part === "..") out.pop()
    else if (part !== "." && part !== "") out.push(part)
  }
  return (p.startsWith("/") ? "/" : "") + out.join("/")
}
