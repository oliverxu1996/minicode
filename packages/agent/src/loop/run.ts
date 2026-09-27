import type { Model, ModelResponse } from "@minicode/model"
import type { Session } from "../session/session"
import type { RunEvent, RunFinishReason, SessionMessage } from "../session/types"
import { CODING_TOOLS } from "../tools"
import { createSkillTool } from "../tools/skill"
import type { Tool, ToolResult } from "../tools/types"
import { truncateOutput } from "../tools/truncate"
import { AgentLoop } from "./loop"

/** Everything a single autonomous run needs. The model is injected, which
 *  is the test seam: production resolves it via `@minicode/model`
 *  ModelManager, tests supply a scripted fake. */
export interface RunDeps {
  session: Session
  model: Model
  task: string
  signal?: AbortSignal
  /** Maximum model iterations before the run is force-terminated. */
  maxIterations?: number
  /** Base delay for rate-limit auto-retry backoff. Test seam. */
  autoRetryDelayMs?: number
  /** Project instructions (AGENTS.md) injected into the system prompt. */
  projectInstructions?: string | null
  /** Skills exposed to the model through the skill tool + system prompt. */
  skills?: import("../config/resources").Skill[]
  /** Proactive compaction settings. */
  autoCompact?: { enabled: boolean; thresholdPct: number }
  /** Toolset override; defaults to the fixed coding toolset. */
  tools?: ReadonlyMap<string, Tool>
  onEvent?: (event: RunEvent) => void
}

export interface RunResult {
  aborted: boolean
  finishReason: RunFinishReason
  iterations: number
  inputTokens?: number
  outputTokens?: number
  error?: string
}

/**
 * One autonomous coding run against a session: status transitions,
 * terminal persistence, and the run-event envelope around the loop.
 * Ephemeral — never persisted itself.
 */
export async function runTask(deps: RunDeps): Promise<RunResult> {
  const { session, model, task } = deps
  const emit = deps.onEvent ?? (() => {})

  // Persist 'running' BEFORE execution: a crash mid-run leaves 'running'
  // on disk for recovery to reconcile.
  session.status = "running"
  await session.checkpoint()
  emit({ type: "run_start", sessionId: session.id, task })

  let result: RunResult
  try {
    // The skill tool appears only when skills are available.
    const tools = new Map(deps.tools ?? CODING_TOOLS)
    if (deps.skills !== undefined && deps.skills.length > 0) {
      tools.set("skill", createSkillTool(deps.skills))
    }
    const loop = new AgentLoop(session, model, tools)
    result = await loop.run(task, deps)
  } catch (err) {
    // The loop is contractually non-throwing; this guards runtime bugs so a
    // session never stays stuck in 'running'.
    result = {
      aborted: false,
      finishReason: "error",
      iterations: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Terminal transitions: an aborted run leaves 'interrupted' for the next
  // process; a completed (even failed) run is idle.
  session.status = result.aborted ? "interrupted" : "idle"
  try {
    await session.checkpoint()
  } catch {
    // Terminal persistence failure must not mask the run outcome.
  }
  const usage = result.inputTokens !== undefined || result.outputTokens !== undefined
    ? { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
    : undefined
  emit({
    type: "run_end",
    finishReason: result.finishReason,
    iterations: result.iterations,
    usage,
    error: result.error,
  })
  return result
}

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
  } = { iteration: 0 },
): Promise<void> {
  const emit = opts.onEvent ?? (() => {})

  // The bash tool runs in the session workspace unless told otherwise.
  if (name === "bash" && (input.workdir === undefined || input.workdir === "") && session.cwd) {
    input.workdir = session.cwd
  }

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
      output = await tool.execute(input, { toolCallId, cwd: session.cwd, signal: opts.signal })
    } catch (err) {
      output = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // read output is already shaped and capped by the tool itself.
  const truncated = name === "read" ? output : truncateOutput(output, session.cwd, name)

  const toolMsg = session.toolResultMessageFor(assistantMsg)
  session.appendToolResult(toolMsg, {
    toolCallId,
    toolName: name,
    output: truncated.ok
      ? { type: "text", text: truncated.data }
      : { type: "tool_error", text: truncated.error },
  })
  session.ledger.finished(toolCallId, truncated.ok ? "succeeded" : "failed")
  // Result + final ledger state land in ONE checkpoint: no crash window can
  // separate a recorded outcome from its tool-result part.
  await session.checkpoint()

  emit({
    type: "tool_result",
    iteration: opts.iteration,
    toolCallId,
    name,
    ok: truncated.ok,
    result: truncated.ok ? truncated.data : truncated.error ?? "",
  })
}

/** Extracts the assistant history content from a model response. */
export function assistantContentFrom(response: ModelResponse): import("@minicode/model").ModelAssistantPart[] {
  const content: import("@minicode/model").ModelAssistantPart[] = []
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
