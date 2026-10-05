import type { MiniCode, RunSummary, Session } from "@minicode/agent"
import { resultLine } from "./projection"

/** Where the non-interactive application writes. */
export interface PrintIO {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

/**
 * The non-interactive application: execute one task against a session and
 * translate the runtime's result into print or JSON output.
 *
 * Text mode prints the run's final assistant response (and the run's error, if
 * any, to stderr); JSON mode streams every `RunEvent` as a JSON line and then
 * emits the result line. Returns the process exit code: `0` when the run
 * reached a final answer (`stop`), `1` otherwise.
 */
export async function runPrint(
  agent: MiniCode,
  session: Session,
  task: string,
  jsonMode: boolean,
  io: PrintIO,
): Promise<number> {
  // The run's own record, taken from the stream rather than rebuilt, so the
  // final line carries the same summary the session persists.
  let run: RunSummary | undefined
  const result = await agent.run(session, task, {
    onEvent: event => {
      if (event.type === "run_end") run = event.run
      if (jsonMode) {
        io.stdout(JSON.stringify(event) + "\n")
      }
    },
  })

  if (jsonMode) {
    io.stdout(JSON.stringify(resultLine(result.finishReason, result.iterations, result.error, run)) + "\n")
  } else {
    const last = session.lastAssistant()
    const text = last !== undefined
      ? last.content.filter(part => part.type === "text").map(part => part.text).join("")
      : ""
    io.stdout(text + "\n")
    if (result.error !== undefined) io.stderr(`minicode: ${result.error}\n`)
  }
  return result.finishReason === "stop" ? 0 : 1
}
