import type {
  Model,
  ModelAssistantPart,
  ModelFinishReason,
  ModelResponse,
  ModelToolCall,
  ModelUsage,
} from "@minicode/model"
import { ModelError } from "@minicode/model"
import { contextBudget } from "../context-budget"
import type { Session } from "../session/session"
import type { RunEvent } from "../session/types"
import { toModelTools, type Tool } from "../tools"
import { Compactor } from "./compact"
import { assistantContentFrom, executeTool } from "./run"
import type { RunResult } from "./run"
import { buildSystemPrompt } from "./system-prompt"

export interface LoopOptions {
  signal?: AbortSignal
  maxIterations?: number
  /** Base delay for auto-retry backoff (2s, 4s, …). Test seam. */
  autoRetryDelayMs?: number
  onEvent?: (event: RunEvent) => void
}

const DEFAULT_MAX_ITERATIONS = 100
/** Identical consecutive tool calls tolerated before doom-loop protection. */
const DOOM_LOOP_THRESHOLD = 3
/** Compaction retries per run on provider-reported context overflow. */
const MAX_COMPACTION_RETRIES = 5
/** Delayed retries of a rate-limited model call (auto-retry). */
const MAX_AUTO_RETRIES = 3
const AUTO_RETRY_DELAY_MS = 2000

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

    // The task is durable before anything can fail.
    this.session.pushUser(task)
    await this.session.checkpoint()

    // Reconcile an interrupted run before the model is invoked; its note
    // reaches exactly the next model context.
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

    const budget = contextBudget(this.model.limits)
    const compactor = new Compactor(this.model, this.model.limits.contextWindow)
    const system = buildSystemPrompt(this.session)

    let iterations = 0
    let inputTokens = 0
    let outputTokens = 0
    let compactionRetries = 0
    let retryAttempt = 0
    const recentCalls: string[] = []

    while (true) {
      iterations++
      if (iterations > maxIterations) {
        return { aborted: false, finishReason: "max-iterations", iterations, inputTokens, outputTokens }
      }
      if (signal?.aborted) return { aborted: true, finishReason: "aborted", iterations, inputTokens, outputTokens }

      emit({ type: "iteration_start", iteration: iterations })

      // Stream the model response: text deltas reach the UI as they arrive
      // (assistant_delta), tool calls and usage accumulate into the same
      // normalized shapes the generate() path produced.
      let content = ""
      const toolCalls: ModelToolCall[] = []
      let usage: ModelUsage | undefined
      let finishReason: ModelFinishReason = "unknown"
      try {
        const stream = this.model.stream({
          messages: this.session.toRequestMessages(),
          tools: toModelTools(this.tools),
          // Per-request output ceiling from the locked 75/25 budget.
          maxOutputTokens: budget.outputBudget,
          signal,
        })
        for await (const event of stream) {
          // Cancellation mid-stream is surfaced by the model layer as a
          // `cancelled` ModelError through the signal it was given.
          switch (event.type) {
            case "text_delta":
              content += event.text
              emit({ type: "assistant_delta", iteration: iterations, text: event.text })
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
        }
      } catch (err) {
        if (signal?.aborted || (err instanceof ModelError && err.code === "cancelled")) {
          return { aborted: true, finishReason: "aborted", iterations, inputTokens, outputTokens }
        }
        // Provider-reported overflow: compact and retry the iteration —
        // bounded, so a pathological model cannot loop forever.
        if (err instanceof ModelError && err.code === "context_exceeded") {
          if (compactionRetries >= MAX_COMPACTION_RETRIES) {
            return { aborted: false, finishReason: "error", iterations, inputTokens, outputTokens, error: err.message }
          }
          compactionRetries += 1
          const removed = await compactor.compact(this.session)
          await this.session.checkpoint()
          if (removed > 0) {
            iterations -= 1 // the retried attempt replaces this one
            continue
          }
          return { aborted: false, finishReason: "error", iterations, inputTokens, outputTokens, error: err.message }
        }
        // Auto-retry: transient provider throttling gets a bounded
        // sequence of delayed retries (with an event so the UI can show it).
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
            return { aborted: true, finishReason: "aborted", iterations, inputTokens, outputTokens }
          }
          iterations -= 1 // the retried attempt replaces this one
          continue
        }
        return {
          aborted: false,
          finishReason: "error",
          iterations,
          inputTokens,
          outputTokens,
          error: err instanceof Error ? err.message : String(err),
        }
      }

      if (usage?.inputTokens !== undefined) inputTokens += usage.inputTokens
      if (usage?.outputTokens !== undefined) outputTokens += usage.outputTokens

      const response: ModelResponse = {
        content,
        toolCalls,
        usage,
        finishReason,
      }

      const assistantMsg = this.session.appendAssistant(
        assistantContentFrom(response) as ModelAssistantPart[],
        { usage: response.usage, finishReason: response.finishReason },
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
        return { aborted: false, finishReason: runFinishReason, iterations, inputTokens, outputTokens }
      }

      // Execute the requested calls sequentially, in provider order.
      for (const call of response.toolCalls) {
        if (signal?.aborted) return { aborted: true, finishReason: "aborted", iterations, inputTokens, outputTokens }
        await executeTool(this.session, this.tools, assistantMsg, call.toolName, call.toolCallId, call.input as Record<string, unknown>, {
          iteration: iterations,
          signal,
          onEvent: emit,
        })

        const key = `${call.toolName}\u0000${JSON.stringify(call.input)}`
        recentCalls.push(key)
        if (
          recentCalls.length >= DOOM_LOOP_THRESHOLD &&
          recentCalls.slice(-DOOM_LOOP_THRESHOLD).every(k => k === key)
        ) {
          return { aborted: false, finishReason: "doom-loop", iterations, inputTokens, outputTokens }
        }
      }

      // Reactive overflow: the input budget is spent — compact before the
      // next request. If compaction is impossible, stop deterministically.
      if (compactor.isOverflow(response.usage)) {
        const removed = await compactor.compact(this.session)
        await this.session.checkpoint()
        emit({ type: "compaction", summarizedMessages: removed })
        if (removed === 0) {
          return {
            aborted: false,
            finishReason: "error",
            iterations,
            inputTokens,
            outputTokens,
            error: "context overflow detected but compaction made no progress",
          }
        }
      }
    }
  }
}
