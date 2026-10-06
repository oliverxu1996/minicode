import type { Model, ModelUsage } from "@minicode/model"
import type { PruneStats } from "../context/projection"
import type { Session } from "../session/session"
import type {
  ModelIdentity,
  RunFinishReason,
  SessionMessage,
} from "../session/types"
import type { RunEvent } from "./events"
import { CODING_TOOLS } from "../tools"
import { createSkillTool } from "../tools/skill"
import type { Tool } from "../tools/types"
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

/**
 * How a run ended. Deliberately carries no token counts: a run's usage is
 * `RunSummary.usage` on `session.runs`, the one authoritative record. A second
 * total here could only diverge from it — and did, because the loop's counters
 * never saw compaction calls.
 */
export interface RunResult {
  aborted: boolean
  finishReason: RunFinishReason
  iterations: number
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

  const identity = modelIdentity(model)
  // The session owns the run lifecycle. `beginRun` establishes the run
  // identity, appends the initial record (only the facts known before the run
  // starts — every terminal fact stays absent until it ends), moves the session
  // to 'running', and checkpoints, so this layer never writes `session.status`
  // or `session.runs` directly.
  const started = await session.beginRun(identity)
  const runId = started.id

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

  // `beginRun` already persisted 'running' and the partial record BEFORE
  // execution, so a crash mid-run leaves 'running' on disk for recovery to
  // reconcile. `run_start` is delivered INSIDE the protected region: a
  // throwing event consumer must not escape before the run reaches its
  // terminal transition, or the session would be stranded as active. The
  // consumer's failure becomes the run's error outcome (never a success).
  let result: RunResult
  try {
    emit({ type: "run_start", sessionId: session.id, runId, task, model: identity })
    // The skill tool appears only when skills are available.
    const tools = new Map(deps.tools ?? CODING_TOOLS)
    if (deps.skills !== undefined && deps.skills.length > 0) {
      tools.set("skill", createSkillTool(deps.skills))
    }
    const loop = new AgentLoop(session, model, tools)
    result = await loop.run(task, { ...deps, onEvent: emit, onPrune: recordPrune })
  } catch (err) {
    // The loop is contractually non-throwing; this guards runtime bugs and a
    // throwing event consumer so a session never stays stuck in 'running'.
    result = {
      aborted: false,
      finishReason: "error",
      iterations: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Terminal transitions are session-owned: an aborted run leaves
  // 'interrupted' for the next process; a completed (even failed) run is idle.
  // `finishRun` writes the terminal record, transitions the state, and
  // checkpoints (swallowing terminal persistence failure so it cannot mask the
  // outcome) — this layer supplies only the outcome.
  const finished = await session.finishRun(runId, {
    aborted: result.aborted,
    finishReason: result.finishReason,
    usage,
    modelCalls,
    toolCalls,
    ...(pruning === undefined ? {} : { pruning }),
    ...(result.error === undefined ? {} : { error: result.error }),
  })
  emit({
    type: "run_end",
    runId,
    finishReason: result.finishReason,
    iterations: result.iterations,
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
