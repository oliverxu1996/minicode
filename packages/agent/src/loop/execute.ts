/**
 * Tool execution and assistant-content conversion.
 *
 * These live here rather than in `run.ts` because both are needed by the loop
 * engine while `run.ts` constructs that engine — importing them from `run.ts`
 * made `loop.ts` and `run.ts` mutually dependent. Nothing in this module
 * imports either of them, so the cycle is gone and each side can be read,
 * moved and tested on its own.
 *
 * The ordering invariant documented on `executeTool` is load-bearing for crash
 * recovery; see `Session.recover`.
 */
import type { ModelAssistantPart, ModelResponse } from "@loongcode/model"
import { toolDurationMs } from "../session/ledger"
import type { Session } from "../session/session"
import type { SessionMessage } from "../session/types"
import type { RunEvent } from "./events"
import type { Tool, ToolResult } from "../tools/types"
import { truncateOutput } from "../tools/truncate"

/**
 * Executes one tool call with the crash-safe ordering invariant:
 *
 *   ledger.pending → CHECKPOINT → ledger.running → CHECKPOINT → execute →
 *   truncate → result appended to the tool message + ledger.finished → CHECKPOINT
 *
 * A crash in any window leaves a deterministically reconcilable state
 * (see Session.recover). Tool failures are data, never run-terminating.
 */
export async function executeTool(
  session: Session,
  tools: ReadonlyMap<string, Tool>,
  assistantMsg: SessionMessage & { role: "assistant" },
  name: string,
  toolCallId: string,
  input: Record<string, unknown>,
  opts: {
    iteration: number
    reissue?: boolean
    signal?: AbortSignal
    onEvent?: (event: RunEvent) => void
    /**
     * Awaited immediately before the tool performs its side effect, so file
     * checkpoints capture the state a tool is about to overwrite rather than
     * reconstructing it from the call text afterwards.
     */
    onBeforeExecute?: (name: string, input: Record<string, unknown>) => Promise<void>
  } = { iteration: 0 },
): Promise<void> {
  const emit = opts.onEvent ?? (() => {})

  // The bash tool runs in the session workspace unless told otherwise. That
  // default is resolved into a LOCAL execution input rather than written back
  // into `input`: `input` is the object the assistant message holds by
  // reference, so mutating it here rewrote durable history — the recorded call
  // no longer stated what the model actually asked for. The same object is
  // also recorded in the ledger and emitted in `tool_call`, so all three now
  // reflect the model's request, and execution still gets the workspace.
  const execInput =
    name === "bash" && (input.workdir === undefined || input.workdir === "") && session.cwd
      ? { ...input, workdir: session.cwd }
      : input

  if (!opts.reissue) {
    emit({ type: "tool_call", iteration: opts.iteration, toolCallId, name, input })
  }

  // CRITICAL ORDERING: the pending entry must be durably persisted before
  // anything else happens.
  session.ledger.pending({ toolCallId, name, input })
  await session.checkpoint()

  session.ledger.running(toolCallId)
  await session.checkpoint()

  const tool = tools.get(name)
  let output: ToolResult
  if (tool === undefined) {
    output = { ok: false, error: `unknown tool ${name}` }
  } else {
    try {
      await opts.onBeforeExecute?.(name, execInput)
      output = await tool.execute(execInput, {
        toolCallId,
        cwd: session.cwd,
        signal: opts.signal,
        onOutput: (text: string) => {
          emit({ type: "tool_progress", iteration: opts.iteration, toolCallId, name, text })
        },
      })
    } catch (err) {
      output = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // read output is already shaped and capped by the tool itself.
  const truncated = name === "read" ? output : truncateOutput(output, name)

  const toolMsg = session.toolResultMessageFor(assistantMsg)
  session.appendToolResult(toolMsg, {
    toolCallId,
    toolName: name,
    output: truncated.ok
      ? { type: "text", text: truncated.data }
      : { type: "tool_error", text: truncated.error },
  })
  // The command *observed* a failure: keep this turn out of request-time
  // pruning so a repair loop never loses the evidence it needs.
  if (truncated.ok && truncated.failureEvidence === true) {
    session.markFailureEvidence(toolMsg)
  }
  // How to get back to anything the cap withheld. Declared structurally by
  // whichever layer capped (the tool itself, or the spill above) so request-time
  // pruning never has to recognise the wording of the message above, and keyed
  // by this call's id so a sibling result in the same turn cannot be handed
  // this one's recovery.
  if (truncated.ok && truncated.affordances !== undefined) {
    session.markAffordances(toolMsg, toolCallId, truncated.affordances)
  }
  session.ledger.finished(toolCallId, truncated.ok ? "succeeded" : "failed")
  // Result + final ledger state land in ONE checkpoint: no crash window can
  // separate a recorded outcome from its tool-result part.
  await session.checkpoint()

  // Derived, not stored: the ledger's timestamps stay the durable source, and
  // an invocation that recorded only one end reports no duration at all.
  const entry = session.ledger.get(toolCallId)
  const durationMs = entry === undefined ? undefined : toolDurationMs(entry)

  emit({
    type: "tool_result",
    iteration: opts.iteration,
    toolCallId,
    name,
    ok: truncated.ok,
    result: truncated.ok ? truncated.data : truncated.error ?? "",
    ...(durationMs === undefined ? {} : { durationMs }),
  })
}

/** Extracts the assistant history content from a model response. */
export function assistantContentFrom(response: ModelResponse): ModelAssistantPart[] {
  const content: ModelAssistantPart[] = []
  if (response.content.length > 0) {
    content.push({ type: "text", text: response.content })
  }
  for (const call of response.toolCalls) {
    content.push({
      type: "tool_call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    })
  }
  return content
}
