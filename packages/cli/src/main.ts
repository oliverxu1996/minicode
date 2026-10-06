import { MiniCode, migrateLegacyConfig } from "@minicode/agent"
import { MINICODE_VERSION } from "./version"
import { MiniCodeTui } from "./interactive/app"
import { runPrint } from "./print"

/**
 * MiniCode entry point.
 *
 * ```txt
 * bun packages/cli/src/main.ts [options] [workspace-directory]
 * ```
 *
 * The same entry point backs every distribution: running from a checkout, the
 * npm package's bundled `minicode` binary, and the standalone release build.
 * Nothing about the CLI differs between them.
 *
 * Options:
 *   --print, -p <task>   Non-interactive: run the task and print the final
 *                        response (add --mode json to stream events as JSONL)
 *   --mode json          With -p: emit every RunEvent as a JSON line
 *   --continue, -c       Continue the most recent session in the workspace
 *   --resume <id>        Resume a specific session
 *   --version, -v        Print the version
 *   --help, -h           Print usage
 *
 * The workspace directory defaults to the current directory. Model
 * configuration comes from `@minicode/model` ModelManager (the configured
 * active model) — or use /model inside the TUI on first run.
 *
 * Interactive mode needs a terminal, so it is refused when stdin is not a TTY
 * (see `runCli`); use -p for scripts, pipes, and CI.
 */

interface CliArgs {
  cwd: string
  print: string | null
  jsonMode: boolean
  resumeId: string | null
  continueLatest: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { cwd: process.cwd(), print: null, jsonMode: false, resumeId: null, continueLatest: false }
  let positional: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--print" || arg === "-p") {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) {
        args.print = "" // read remaining positional
      } else {
        args.print = next
        i++
      }
    } else if (arg === "--mode" && argv[i + 1] === "json") {
      args.jsonMode = true
      i++
    } else if (arg === "--resume") {
      args.resumeId = argv[i + 1] ?? null
      i++
    } else if (arg === "--continue" || arg === "-c") {
      args.continueLatest = true
    } else if (arg === "--cwd") {
      args.cwd = argv[i + 1] ?? process.cwd()
      i++
    } else if (!arg.startsWith("--")) {
      positional = arg
    }
  }
  if (args.print !== null && args.print.length === 0 && positional !== null) {
    args.print = positional
    positional = null
  }
  if (positional !== null) args.cwd = positional
  return args
}

async function resolveSession(agent: MiniCode, args: CliArgs): Promise<{ session: ReturnType<MiniCode["createSession"]> | null; label: string }> {
  if (args.resumeId !== null) {
    return { session: await agent.loadSession(args.resumeId), label: args.resumeId }
  }
  if (args.continueLatest) {
    const summaries = await agent.sessionSummaries()
    const inWorkspace = summaries.filter(s => s.cwd === args.cwd)
    if (inWorkspace.length > 0) {
      const session = await agent.loadSession(inWorkspace[0]!.id)
      return { session, label: args.cwd }
    }
  }
  return { session: null, label: args.cwd }
}

/** Where runCli writes, so the CLI can be driven from tests. */
export interface CliIO {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** False in scripts, pipes, and CI, where the interactive TUI cannot run. */
  readonly stdinIsTTY: boolean
}

export function helpText(): string {
  return `MiniCode — standalone coding agent

usage: minicode [options] [workspace]

  -p, --print <task>   run one task and print the final response
      --mode json      with -p: emit RunEvents as JSON lines
  -c, --continue       continue the most recent session in the workspace
      --resume <id>    resume a specific session
      --cwd <dir>      workspace directory (default: current directory)
  -v, --version        print the MiniCode version
  -h, --help           show this help

first run: use /model inside the TUI to configure a model
(protocol, endpoint, model name, API key), or write
~/.minicode/models.json directly.`
}

/**
 * Run the CLI. Returns the process exit code, or `null` when the interactive
 * TUI has taken over the process — it owns its own shutdown.
 */
export async function runCli(argv: string[], io: CliIO): Promise<number | null> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(helpText() + "\n")
    return 0
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    io.stdout(MINICODE_VERSION + "\n")
    return 0
  }

  // Carry over a pre-`~/.minicode` install once, before anything reads config.
  migrateLegacyConfig()

  const args = parseArgs(argv)

  // ── non-interactive mode ─────────────────────────────────────────
  if (args.print !== null) {
    const agent = new MiniCode()
    const { session } = await resolveSession(agent, args)
    const active = session ?? agent.createSession(args.cwd)
    return runPrint(agent, active, args.print, args.jsonMode, io)
  }

  // ── interactive TUI ──────────────────────────────────────────────
  // The TUI reads keystrokes from stdin. Without a terminal it would sit
  // waiting on input that never arrives, painting escape sequences into a
  // pipe, so refuse before starting it rather than hang.
  if (!io.stdinIsTTY) {
    io.stderr(
      `minicode: stdin is not a terminal, so the interactive UI cannot start.\n` +
      `Run a single task instead:  minicode -p "<task>"\n`,
    )
    return 1
  }

  const agent = new MiniCode()
  const { session: resumed, label } = await resolveSession(agent, args)
  const session = resumed ?? agent.createSession(args.cwd)
  const app = new MiniCodeTui({ agent, session, label })
  app.start()
  return null
}

if (import.meta.main) {
  runCli(process.argv.slice(2), {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    stdinIsTTY: Boolean(process.stdin.isTTY),
  }).then(
    code => {
      if (code !== null) process.exit(code)
    },
    err => {
      process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n")
      process.exit(1)
    },
  )
}
