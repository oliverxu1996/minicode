import type { Model, ModelResponse, ModelUsage } from "@minicode/model"
import { toolDurationMs } from "../session/ledger"
import type { PruneStats } from "../session/prune"
import type { Session } from "../session/session"
import type {
  ModelIdentity,
  RunEvent,
  RunFinishReason,
  RunSummary,
  SessionMessage,
} from "../session/types"
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
  const callerOnEvent = deps.onEvent

  // This run's record. Only the facts known before it starts are written now;
  // every terminal fact stays absent until the run actually ends, so a run
  // that crashes or is interrupted keeps an honest record of what was known.
  const runId = crypto.randomUUID()
  const startedAt = Date.now()
  const identity = modelIdentity(model)
  const started: RunSummary = { id: runId, startedAt, model: identity }
  session.runs.push(started)

  // Counted from the run's own event stream rather than from loop internals,
  // so the record and what an external JSONL consumer reads cannot disagree:
  // `modelCalls` is the number of `model_response` events, `toolCalls` the
  // number of `tool_result` events, and `usage` the sum of every event that
  // reports it — normal responses and compaction calls alike.
  let modelCalls = 0
  let toolCalls = 0
  let usage: ModelUsage = {}
  let pruning: PruneStats | undefined

  const emit = (event: RunEvent): void => {
    if (event.type === "model_response") {
      modelCalls += 1
      usage = sumUsage(usage, event.usage)
    } else if (event.type === "tool_result") {
      toolCalls += 1
    } else if (event.type === "compaction") {
      // A compaction's summarization call never emits `model_response`, so its
      // cost reaches the run total here and nowhere else — counted exactly once.
      usage = sumUsage(usage, event.usage)
    }
    callerOnEvent?.(event)
  }

  // Pruning reports through a callback rather than an event, so the run totals
  // are accumulated here and land on the record.
  const recordPrune = (stats: PruneStats): void => {
    pruning = {
      reduced: (pruning?.reduced ?? 0) + stats.reduced,
      originalBytes: (pruning?.originalBytes ?? 0) + stats.originalBytes,
    }
  }

  // Persist 'running' BEFORE execution: a crash mid-run leaves 'running'
  // on disk for recovery to reconcile, alongside this run's partial record.
  session.status = "running"
  await session.checkpoint()
  emit({ type: "run_start", sessionId: session.id, runId, task, model: identity })

  let result: RunResult
  try {
    // The skill tool appears only when skills are available.
    const tools = new Map(deps.tools ?? CODING_TOOLS)
    if (deps.skills !== undefined && deps.skills.length > 0) {
      tools.set("skill", createSkillTool(deps.skills))
    }
    const loop = new AgentLoop(session, model, tools)
    result = await loop.run(task, { ...deps, onEvent: emit, onPrune: recordPrune })
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
  const finished: RunSummary = {
    ...started,
    finishedAt: Date.now(),
    finishReason: result.finishReason,
    usage,
    modelCalls,
    toolCalls,
    ...(pruning === undefined ? {} : { pruning }),
    ...(result.error === undefined ? {} : { error: result.error }),
  }
  const index = session.runs.findIndex(run => run.id === runId)
  if (index !== -1) session.runs[index] = finished
  try {
    await session.checkpoint()
  } catch {
    // Terminal persistence failure must not mask the run outcome.
  }
  const legacyUsage = result.inputTokens !== undefined || result.outputTokens !== undefined
    ? { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
    : undefined
  emit({
    type: "run_end",
    runId,
    finishReason: result.finishReason,
    iterations: result.iterations,
    usage: legacyUsage,
    error: result.error,
    run: finished,
  })
  return result
}

/** The identity of a model, as recorded on a run. Credentials and the endpoint
 *  are deliberately not part of it. */
function modelIdentity(model: Model): ModelIdentity {
  return {
    id: model.id,
    name: model.name,
    protocol: model.protocol,
    model: model.model,
    contextWindow: model.limits.contextWindow,
    maxOutputTokens: model.limits.maxOutputTokens,
  }
}

/** Every token field of `ModelUsage`, so a field added later is summed too. */
const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof ModelUsage)[]

/** Adds one model call's usage into a run total.
 *
 *  Every field is summed independently: the cache and reasoning fields
 *  decompose the two totals rather than adding to them, so their sums remain
 *  subsets of the totals' sums. A field no call reported stays absent. */
function sumUsage(total: ModelUsage, call: ModelUsage | undefined): ModelUsage {
  if (call === undefined) return total
  const summed: Record<string, number> = { ...total }
  for (const key of USAGE_KEYS) {
    const value = call[key]
    if (value === undefined) continue
    summed[key] = (summed[key] ?? 0) + value
  }
  return summed as ModelUsage
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
  const truncated = name === "read" ? output : truncateOutput(output, session.cwd, name)

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
