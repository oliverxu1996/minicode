import type { Tool, ToolExecutionContext, ToolResult } from "./types"

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const MAX_OUTPUT_BYTES = 50 * 1024

/** Exit-code sentinel appended to output so the model always sees the
 *  command result; a non-zero exit is data, not a runtime failure. */
export const bashTool: Tool = {
  description:
    "Execute a shell command (/bin/sh) in the repository and observe its output. " +
    "Use for builds, tests, git status/diff, and any repository-specific verification. " +
    "Output is truncated to the last 50KB. The exit code is appended to the output.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute. Supports pipes, redirects, and variable expansion." },
      workdir: { type: "string", description: "Working directory for the command. Defaults to the session workspace." },
      timeout: { type: "integer", minimum: 1, description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT} (2 minutes). Max ${MAX_TIMEOUT} (10 minutes).` },
    },
    required: ["command"],
  },

  async execute(input: unknown, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { command, workdir, timeout } = input as {
      command?: string
      workdir?: string
      timeout?: number
    }
    if (typeof command !== "string" || command.trim().length === 0) {
      return { ok: false, error: "Command is empty." }
    }
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1)) {
      return { ok: false, error: "timeout must be a positive integer (milliseconds)" }
    }

    let cwd: string
    if (workdir === undefined || workdir === "") {
      cwd = ctx?.cwd ?? process.cwd()
    } else {
      const resolved = resolveWorkdir(workdir, ctx?.cwd)
      const stat = await Bun.file(resolved).stat().catch(() => null)
      if (!stat?.isDirectory?.()) {
        return { ok: false, error: `workdir does not exist or is not a directory: ${resolved}` }
      }
      cwd = resolved
    }

    const effectiveTimeout = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT, 1), MAX_TIMEOUT)
    const timeoutController = new AbortController()
    const timeoutHandle = setTimeout(() => timeoutController.abort(), effectiveTimeout)
    // The run's cancellation signal also kills the command: aborting a run
    // must not wait out a long-running child.
    const signal = ctx?.signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([timeoutController.signal, ctx.signal])

    let result: { stdout: string; stderr: string; exitCode: number }
    try {
      const proc = Bun.spawn(["/bin/sh", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
        cwd,
        signal,
        env: { ...process.env },
      })
      const readStreaming = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        let text = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          text += chunk
          ctx?.onOutput?.(chunk)
        }
        return text
      }
      const [stdout, stderr] = await Promise.all([
        readStreaming(proc.stdout),
        readStreaming(proc.stderr),
      ])
      const exitCode = await proc.exited
      result = { stdout, stderr, exitCode }
    } catch (err) {
      clearTimeout(timeoutHandle)
      if (timeoutController.signal.aborted) {
        return {
          ok: false,
          error: `Command timed out after ${formatDuration(effectiveTimeout)} and was terminated.`,
        }
      }
      if (ctx?.signal?.aborted) {
        return { ok: false, error: "Command cancelled: the run was aborted." }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Command execution failed: ${message}` }
    }
    clearTimeout(timeoutHandle)

    if (timeoutController.signal.aborted) {
      return {
        ok: false,
        error: `Command timed out after ${formatDuration(effectiveTimeout)}.\nPartial output:\n${truncate(result.stdout, result.stderr)}`,
      }
    }

    // A non-zero exit is `ok: true` — exit codes are data, not tool errors.
    // The text stays byte-identical; `failureEvidence` only records that the
    // command *observed* a failure, so request-time pruning keeps it.
    const data = `${truncate(result.stdout, result.stderr)}\n(exit code: ${result.exitCode})`
    return result.exitCode === 0
      ? { ok: true, data }
      : { ok: true, data, failureEvidence: true }
  },
}

function resolveWorkdir(workdir: string, cwd?: string): string {
  const base = cwd ?? process.cwd()
  const resolved = workdir.startsWith("/") ? workdir : `${base}/${workdir}`
  return resolved.replace(/\/+$/, "") || "/"
}

function truncate(stdout: string, stderr: string): string {
  let combined = stdout
  if (stderr) combined += `\n(stderr)\n${stderr}`
  const totalBytes = Buffer.byteLength(combined, "utf-8")
  if (totalBytes <= MAX_OUTPUT_BYTES) return combined

  const buf = Buffer.from(combined, "utf-8")
  let start = buf.length - MAX_OUTPUT_BYTES
  if (start < 0) start = 0
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  const preview = buf.subarray(start).toString("utf-8")
  const kb = (totalBytes / 1024).toFixed(1)
  const cap = `${MAX_OUTPUT_BYTES / 1024}KB`
  return `(Output truncated to last ${cap}. Full output was approximately ${kb}KB. Use a more specific command to reduce output.)\n\n${preview}`
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}
