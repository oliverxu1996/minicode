import { MiniCode } from "../minicode"
import { MiniCodeTui } from "./app"

/**
 * MiniCode TUI entry point.
 *
 * ```txt
 * bun packages/agent/src/tui/main.ts [workspace-directory]
 * ```
 *
 * The workspace directory defaults to the current directory. Model
 * configuration comes from `@minicode/model` ModelManager (the configured
 * active model).
 */

function usage(): never {
	console.error("usage: bun packages/agent/src/tui/main.ts [workspace-directory]")
	process.exit(1)
}

const args = process.argv.slice(2).filter(arg => arg !== "--")
const cwd = args[0]
if (args.length > 1) usage()

async function main(): Promise<void> {
	const workspace = cwd ?? process.cwd()
	const agent = new MiniCode()
	const session = agent.createSession(workspace)
	const app = new MiniCodeTui({ agent, session })
	app.start()
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : err)
	process.exit(1)
})
