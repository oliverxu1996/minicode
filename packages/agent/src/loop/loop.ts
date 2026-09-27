import type { Model, ModelAssistantPart, ModelResponse } from "@minicode/model"
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
  onEvent?: (event: RunEvent) => void
}

const DEFAULT_MAX_ITERATIONS = 100
/** Identical consecutive tool calls tolerated before doom-loop protection. */
const DOOM_LOOP_THRESHOLD = 3
/** Compaction retries per run on provider-reported context overflow. */
const MAX_COMPACTION_RETRIES = 5

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
    const recentCalls: string[] = []

    while (true) {
      iterations++
      if (iterations > maxIterations) {
        return { aborted: false, finishReason: "max-iterations", iterations, inputTokens, outputTokens }
      }
      if (signal?.aborted) return { aborted: true, finishReason: "aborted", iterations, inputTokens, outputTokens }

      emit({ type: "iteration_start", iteration: iterations })

      let response: ModelResponse
      try {
        response = await this.model.generate({
          messages: this.session.toRequestMessages(),
          tools: toModelTools(this.tools),
          // Per-request output ceiling from the locked 75/25 budget.
          maxOutputTokens: budget.outputBudget,
          signal,
        })
      } catch (err) {
        if (signal?.aborted) return { aborted: true, finishReason: "aborted", iterations, inputTokens, outputTokens }

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
        return {
          aborted: false,
          finishReason: "error",
          iterations,
          inputTokens,
          outputTokens,
          error: err instanceof Error ? err.message : String(err),
        }
      }

      if (response.usage?.inputTokens !== undefined) inputTokens += response.usage.inputTokens
      if (response.usage?.outputTokens !== undefined) outputTokens += response.usage.outputTokens

      const assistantMsg = this.session.appendAssistant(
        assistantContentFrom(response) as ModelAssistantPart[],
        { usage: response.usage, finishReason: response.finishReason },
      )
      emit({
        type: "model_response",
        iteration: iterations,
        finishReason: response.finishReason,
        usage: response.usage,
      })
      await this.session.checkpoint()

      if (response.toolCalls.length === 0) {
        // Final answer (or a truncated one): the turn is over.
        const finishReason = response.finishReason === "stop"
          ? "stop"
          : response.finishReason === "length" ? "length" : "unknown"
        return { aborted: false, finishReason, iterations, inputTokens, outputTokens }
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
