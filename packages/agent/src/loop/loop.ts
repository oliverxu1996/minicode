import type {
  Model,
  ModelAssistantPart,
  ModelFinishReason,
  ModelResponse,
  ModelToolCall,
  ModelUsage,
} from "@minicode/model"
import { ModelError } from "@minicode/model"
import type { Skill } from "../config/resources"
import { contextBudget } from "../context/budget"
import type { PruneStats } from "../context/projection"
import type { RewindRecorder } from "../session/checkpoint"
import type { Session } from "../session/session"
import type { RunEvent } from "./events"
import { toModelTools, type Tool } from "../tools"
import { Compactor } from "../context/compaction"
import { assistantContentFrom, executeTool } from "./execute"
import type { RunResult } from "./run"
import { buildSystemPrompt } from "../context/prompt"

export interface LoopOptions {
  signal?: AbortSignal
  maxIterations?: number
  /** Base delay for auto-retry backoff (2s, 4s, …). Test seam. */
  autoRetryDelayMs?: number
  /** Project instructions injected into the system prompt (AGENTS.md). */
  projectInstructions?: string | null
  /** Skills available to the model via the skill tool. */
  skills?: Skill[]
  /** Proactive compaction settings (from runtime settings). */
  autoCompact?: { enabled: boolean; thresholdPct: number }
  onEvent?: (event: RunEvent) => void
  /** Observability sink forwarded to request pruning. */
  onPrune?: (stats: PruneStats) => void
  /** Records file checkpoints for `/rewind`; absent disables checkpointing. */
  recorder?: RewindRecorder
}

const DEFAULT_MAX_ITERATIONS = 100
/** Identical consecutive tool calls tolerated before doom-loop protection. */
const DOOM_LOOP_THRESHOLD = 3
/** Compaction retries per run on provider-reported context overflow. */
const MAX_COMPACTION_RETRIES = 5
/** Delayed retries of a rate-limited model call (auto-retry). */
const MAX_AUTO_RETRIES = 3
const AUTO_RETRY_DELAY_MS = 2000

/** The `compaction` event for a compaction that actually completed. Built in
 *  one place so every trigger describes it identically. */
function compactionEvent(outcome: { removed: number; usage?: ModelUsage }): RunEvent {
  return {
    type: "compaction",
    summarizedMessages: outcome.removed,
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
  }
}

/** Resolves after `ms`, or early with `true` when the signal aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve(true)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(true)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve(false)
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * The Coding Agent engine:
 * repeatedly invoke the model, execute the tool calls it requests, feed the
 * results back, and stop on a final answer or a runtime guard.
 *
 * One loop suffices here: compaction rewrites history
 * in place and the next iteration simply continues. Guards:
 * - max iterations → 'max-iterations'
 * - 3 identical consecutive tool calls → 'doom-loop'
 * - abort signal wins everywhere → 'aborted'
 * - model errors end the run; context_exceeded compacts once and retries
 * - tool failures never terminate the run — the model sees them as results
 *
 * The model is the `@minicode/model` boundary: no provider or SDK type
 * appears here.
 */
export class AgentLoop {
  constructor(
    private readonly session: Session,
    private readonly model: Model,
    private readonly tools: ReadonlyMap<string, Tool>,
  ) {}

  async run(task: string, opts: LoopOptions = {}): Promise<RunResult> {
    const signal = opts.signal
    const emit = opts.onEvent ?? (() => {})
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS
    const autoRetryDelayMs = opts.autoRetryDelayMs ?? AUTO_RETRY_DELAY_MS

    if (signal?.aborted) return { aborted: true, finishReason: "aborted", iterations: 0 }

    // A checkpoint boundary is exactly here: the turn's user message is about
    // to be appended, so its index is the session's current length.
    //
    // The turn's identity is minted once and handed to both sides, so the
    // checkpoint's turn and the message that begins it cannot disagree. It is
    // also what lets the pairing survive a history rewrite, which the message
    // id cannot: `replaceMessages` regenerates ids.
    const turnId = crypto.randomUUID()
    await opts.recorder?.beginTurn(this.session.id, task, this.session.messages.length, turnId)

    // The task is durable before anything can fail.
    this.session.pushUser(task, turnId)
    await this.session.checkpoint()

    // Reconcile recoverable execution state before a model request. This is
    // the request boundary, invoked immediately before every `model.stream`,
    // not merely once at run start: state can be created mid-run (a steering
    // interruption captures a tool call before it has run), and the next
    // request must not carry an unresolved execution boundary. `recover` is
    // idempotent and a no-op when nothing is actionable, so a request with
    // nothing to reconcile gains no event, note, or durable mutation.
    const reconcileBeforeRequest = async (): Promise<void> => {
      const recovery = await this.session.recover({
        tools: this.tools,
        executeTool: (session, msg, name, toolCallId, input, o) =>
          executeTool(session, this.tools, msg, name, toolCallId, input, {
            iteration: 0,
            reissue: o?.reissue,
            signal: opts.signal,
            onEvent: emit,
          }),
      })
      if (recovery.recovered) emit({ type: "recovery", note: recovery.note })
    }

    // Reconcile an interrupted run before the loop begins; its note reaches
    // exactly the first model context.
    await reconcileBeforeRequest()

    const budget = contextBudget(this.model.limits)
    const compactor = new Compactor(this.model, this.model.limits.contextWindow)
    // Compaction rewrites durable history, so it is always persisted as one
    // step: every trigger below compacts and checkpoints together, never one
    // without the other.
    const compactNow = async () => {
      const outcome = await compactor.compact(this.session)
      await this.session.checkpoint()
      return outcome
    }
    // Built on first use rather than eagerly: constructing the prompt consumes
    // the session's pending recovery note, so it must happen only once a model
    // request is actually about to be sent — the run can still abort first.
    let systemPrompt: string | null = null

    let iterations = 0
    // The last call's input size, used as the pressure signal for proactive
    // compaction and for request pruning. The loop keeps no running token
    // totals: a run's usage is owned by `RunSummary.usage`, summed from the
    // event stream in `runTask`, and a second accumulator here could only
    // diverge from it (it did, whenever a compaction call went uncounted).
    let lastInputTokens = 0
    let compactionRetries = 0
    let retryAttempt = 0
    const autoCompact = opts.autoCompact ?? { enabled: true, thresholdPct: 80 }
    const recentCalls: string[] = []

    while (true) {
      iterations++
      if (iterations > maxIterations) {
        return { aborted: false, finishReason: "max-iterations", iterations }
      }
      if (signal?.aborted) return { aborted: true, finishReason: "aborted", iterations }

      emit({ type: "iteration_start", iteration: iterations })

      // Proactive compaction: the last call's input usage crossing the
      // configured share of the input budget means the next request may
      // not fit — compact now rather than failing mid-flight.
      if (autoCompact.enabled) {
        const threshold = Math.floor(budget.inputBudget * (autoCompact.thresholdPct / 100))
        if (lastInputTokens >= threshold && lastInputTokens > 0) {
          const outcome = await compactNow()
          // Proactive compaction is best-effort: a failure here is not fatal,
          // because the reactive and provider paths still guard the request.
          if (outcome.status === "compacted") {
            emit(compactionEvent(outcome))
          }
        }
      }

      // Stream the model response: text deltas reach the UI as they arrive
      // (assistant_delta), tool calls and usage accumulate into the same
      // normalized shapes the generate() path produced. The iteration
      // controller lets steering interrupt the stream without cancelling
      // the whole run.
      const iterationAbort = new AbortController()
      const streamSignal = signal ? AbortSignal.any([signal, iterationAbort.signal]) : iterationAbort.signal
      let content = ""
      let reasoningText = ""
      const toolCalls: ModelToolCall[] = []
      let usage: ModelUsage | undefined
      let finishReason: ModelFinishReason = "unknown"
      let steered: string | null = null
      try {
        // The request boundary: reconcile immediately before this request is
        // constructed, so no model request carries an unresolved execution
        // boundary. Runs on every iteration, including the one after steering.
        await reconcileBeforeRequest()
        if (systemPrompt === null) {
          systemPrompt = buildSystemPrompt(this.session, {
            projectInstructions: opts.projectInstructions ?? null,
            skills: opts.skills ?? [],
          })
        }
        const stream = this.model.stream({
          // System-level instructions lead the conversation. The provider
          // adapter turns this into each protocol's native mechanism (a
          // top-level `system` parameter on Anthropic, a leading system
          // message on OpenAI). The session's durable history never holds it.
          messages: [
            { role: "system", content: systemPrompt },
            ...this.session.toRequestMessages({
              lastInputTokens,
              inputBudget: budget.inputBudget,
              // Forwarded only when a sink exists, so a run without one builds
              // exactly the context it built before.
              ...(opts.onPrune === undefined ? {} : { onPrune: opts.onPrune }),
            }),
          ],
          tools: toModelTools(this.tools),
          // Per-request output ceiling from the locked 75/25 budget.
          maxOutputTokens: budget.outputBudget,
          signal: streamSignal,
        })
        for await (const event of stream) {
          switch (event.type) {
            case "text_delta":
              content += event.text
              emit({ type: "assistant_delta", iteration: iterations, text: event.text })
              break
            case "reasoning_delta":
              reasoningText += event.text
              emit({ type: "reasoning_delta", iteration: iterations, text: event.text })
              break
            case "tool_call":
              toolCalls.push(event.toolCall)
              break
            case "usage":
              usage = event.usage
              break
            case "finish":
              finishReason = event.reason
              break
          }
          // Steering: a queued instruction interrupts the current stream
          // and redirects the agent (steering semantics). Checked after
          // each event so already-arrived output is kept.
          const steer = this.session.consumeSteer()
          if (steer !== null) {
            steered = steer
            iterationAbort.abort()
            break
          }
        }
      } catch (err) {
        // A steering abort is not a run abort: fall through to the steered
        // continuation below.
        if (steered === null) {
          if (signal?.aborted || (err instanceof ModelError && err.code === "cancelled")) {
            return { aborted: true, finishReason: "aborted", iterations }
          }
          // Provider-reported overflow: compact and retry the iteration —
          // bounded, so a pathological model cannot loop forever.
          if (err instanceof ModelError && err.code === "context_exceeded") {
            if (compactionRetries >= MAX_COMPACTION_RETRIES) {
              return { aborted: false, finishReason: "error", iterations, error: err.message }
            }
            compactionRetries += 1
            const outcome = await compactNow()
            if (outcome.status === "compacted") {
              // The rejected request is not a model call and its usage was
              // never reported; only the compaction that followed is recorded.
              emit(compactionEvent(outcome))
              iterations -= 1 // the retried attempt replaces this one
              continue
            }
            return {
              aborted: false,
              finishReason: "error",
              iterations,
              error:
                outcome.status === "failed"
                  ? `context overflow: compaction failed (${outcome.error})`
                  : `context overflow: compaction made no progress (${outcome.reason})`,
            }
          }
          // Auto-retry: transient provider throttling gets a
          // bounded sequence of delayed retries (surfaced via auto_retry).
          if (err instanceof ModelError && err.code === "rate_limited" && retryAttempt < MAX_AUTO_RETRIES) {
            retryAttempt += 1
            const delayMs = autoRetryDelayMs * 2 ** (retryAttempt - 1)
            emit({
              type: "auto_retry",
              attempt: retryAttempt,
              maxAttempts: MAX_AUTO_RETRIES,
              delayMs,
              errorMessage: err.message,
            })
            const abortedDuringWait = await abortableDelay(delayMs, signal)
            if (abortedDuringWait) {
              return { aborted: true, finishReason: "aborted", iterations }
            }
            iterations -= 1 // the retried attempt replaces this one
            continue
          }
          return {
            aborted: false,
            finishReason: "error",
            iterations,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }

      if (steered !== null) {
        // Keep the partial turn visible, then let the steering instruction
        // redirect the agent from the updated history.
        if (content.trim().length > 0 || toolCalls.length > 0) {
          this.session.appendAssistant(assistantContentFrom({ content, toolCalls, finishReason: "unknown" }) as ModelAssistantPart[], {
            finishReason: "aborted",
          })
        }
        this.session.pushUser(steered)
        await this.session.checkpoint()
        emit({ type: "steered", iteration: iterations })
        iterations -= 1 // steering does not consume an iteration slot
        continue
      }

      if (usage?.inputTokens !== undefined) {
        lastInputTokens = usage.inputTokens
      }
      const response: ModelResponse = {
        content,
        toolCalls,
        usage,
        finishReason,
      }

      const assistantMsg = this.session.appendAssistant(
        assistantContentFrom(response) as ModelAssistantPart[],
        { finishReason: response.finishReason },
      )
      retryAttempt = 0 // a successful call resets the retry streak
      emit({
        type: "model_response",
        iteration: iterations,
        finishReason: response.finishReason,
        usage: response.usage,
      })
      await this.session.checkpoint()

      if (response.toolCalls.length === 0) {
        // Final answer (or a truncated one): the turn is over.
        const runFinishReason = response.finishReason === "stop"
          ? "stop"
          : response.finishReason === "length" ? "length" : "unknown"
        return { aborted: false, finishReason: runFinishReason, iterations }
      }

      // Execute the requested calls sequentially, in provider order.
      for (const call of response.toolCalls) {
        if (signal?.aborted) return { aborted: true, finishReason: "aborted", iterations }
        await executeTool(this.session, this.tools, assistantMsg, call.toolName, call.toolCallId, call.input as Record<string, unknown>, {
          iteration: iterations,
          signal,
          onEvent: emit,
          ...(opts.recorder === undefined ? {} : {
            onBeforeExecute: (name: string, input: Record<string, unknown>) =>
              opts.recorder!.beforeTool(this.session.id, this.session.cwd, name, input),
          }),
        })

        const key = `${call.toolName}\u0000${JSON.stringify(call.input)}`
        recentCalls.push(key)
        if (
          recentCalls.length >= DOOM_LOOP_THRESHOLD &&
          recentCalls.slice(-DOOM_LOOP_THRESHOLD).every(k => k === key)
        ) {
          return { aborted: false, finishReason: "doom-loop", iterations }
        }
      }

      // Reactive overflow: the input budget is spent — compact before the
      // next request. If compaction is impossible, stop deterministically.
      if (compactor.isOverflow(response.usage)) {
        const outcome = await compactNow()
        if (outcome.status === "compacted") {
          emit(compactionEvent(outcome))
        } else {
          return {
            aborted: false,
            finishReason: "error",
            iterations,
            error:
              outcome.status === "failed"
                ? `context overflow detected but compaction failed: ${outcome.error}`
                : `context overflow detected but compaction made no progress: ${outcome.reason}`,
          }
        }
      }
    }
  }
}
