import { MiniCode } from "../minicode"
import { MiniCodeTui } from "./app"

/**
 * MiniCode entry point.
 *
 * ```txt
 * bun packages/agent/src/tui/main.ts [options] [workspace-directory]
 * ```
 *
 * Options:
 *   --print, -p <task>   Non-interactive: run the task and print the final
 *                        response (add --mode json to stream events as JSONL)
 *   --mode json          With -p: emit every RunEvent as a JSON line
 *   --continue, -c       Continue the most recent session in the workspace
 *   --resume <id>        Resume a specific session
 *   --new                Force a new session (default without --continue/--resume)
 *
 * The workspace directory defaults to the current directory. Model
 * configuration comes from `@minicode/model` ModelManager (the configured
 * active model) — or use /login inside the TUI on first run.
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // ── non-interactive modes ────────────────────────────────────────
  if (args.print !== null) {
    const agent = new MiniCode()
    const { session } = await resolveSession(agent, args)
    const active = session ?? agent.createSession(args.cwd)

    const result = await agent.run(active, args.print, {
      onEvent: event => {
        if (args.jsonMode) {
          process.stdout.write(JSON.stringify(event) + "\n")
        }
      },
    })

    if (args.jsonMode) {
      process.stdout.write(JSON.stringify({ type: "result", finishReason: result.finishReason, iterations: result.iterations, error: result.error ?? null }) + "\n")
    } else {
      const last = active.lastAssistant()
      const text = last !== undefined
        ? last.content.filter(part => part.type === "text").map(part => part.text).join("")
        : ""
      process.stdout.write(text + "\n")
      if (result.error !== undefined) process.stderr.write(`minicode: ${result.error}\n`)
    }
    process.exit(result.finishReason === "stop" ? 0 : 1)
  }

  // ── interactive TUI ──────────────────────────────────────────────
  const agent = new MiniCode()
  const { session: resumed, label } = await resolveSession(agent, args)
  const session = resumed ?? agent.createSession(args.cwd)
  const app = new MiniCodeTui({ agent, session, label })
  app.start()
}

const argv = process.argv.slice(2)
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`MiniCode — standalone coding agent

usage: bun packages/agent/src/tui/main.ts [options] [workspace]

  -p, --print <task>   run one task and print the final response
      --mode json      with -p: emit RunEvents as JSON lines
  -c, --continue       continue the most recent session in the workspace
      --resume <id>    resume a specific session
      --cwd <dir>      workspace directory (default: current directory)
  -h, --help           show this help

first run: use /login inside the TUI to configure a model
(protocol, endpoint, model name, API key), or write
$XDG_CONFIG_HOME/minicode/models.json directly.`)
  process.exit(0)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
