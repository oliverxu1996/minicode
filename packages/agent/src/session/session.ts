import type { ModelAssistantPart, ModelMessage, ModelToolResult, ModelUsage } from "@minicode/model"
import type { ModelIdentity, RunFinishReason, RunSummary, SessionMessage, SessionStatus } from "./types"
import { ToolLedger } from "./ledger"
import { pruneOldToolOutputs } from "./prune"
import type { PruneContext, PruneStats, ProjectionMessage } from "./prune"
import type { ToolAffordances } from "../tools/types"

/** Error text for tool calls whose outcome is unknown after an
 *  interruption — never fabricated success. */
export const UNKNOWN_OUTCOME_ERROR = "interrupted by process restart; outcome unknown"

export interface RecoveryReport {
  recovered: boolean
  /** Pending calls reissued with the same toolCallId. */
  reissued: Array<{ toolCallId: string; name: string }>
  /** Calls whose outcome was unknown; resolved by idempotent reissue or an
   *  injected failed result. */
  unknownOutcome: Array<{
    toolCallId: string
    name: string
    resolved: "idempotent-reissue" | "injected-failed-result"
  }>
  /** Markdown note for the next model context. */
  note: string
}

export interface RecoverHooks {
  tools?: ReadonlyMap<string, import("../tools/types").Tool>
  executeTool?: (
    session: Session,
    msg: SessionMessage & { role: "assistant" },
    name: string,
    toolCallId: string,
    input: Record<string, unknown>,
    opts?: { reissue?: boolean; signal?: AbortSignal },
  ) => Promise<void>
}

const EMPTY_REPORT: RecoveryReport = { recovered: false, reissued: [], unknownOutcome: [], note: "" }

/**
 * The terminal facts of one run, supplied to {@link Session.finishRun}.
 *
 * Mirrors `RunSummary`'s terminal fields exactly: every field the run engine
 * always produces is required, and the two that stay absent when they do not
 * apply (`pruning`, `error`) are optional, so the persisted record is
 * byte-identical to the one the engine used to write directly.
 */
export interface RunOutcome {
  /** True when the run ended because its signal aborted. */
  readonly aborted: boolean
  readonly finishReason: RunFinishReason
  readonly usage: ModelUsage
  readonly modelCalls: number
  readonly toolCalls: number
  /** Absent when the run never pruned anything. */
  readonly pruning?: PruneStats
  /** Present only when the run ended in an error. */
  readonly error?: string
}

/**
 * Durable coding-task session: the canonical message history, the tool
 * ledger, and the run status.
 *
 * Everything the model sees between turns comes from here; everything
 * durable is written through `checkpoint()` (atomic store writes). A fresh
 * process can reconstruct a session — and reconcile an interrupted run —
 * from the persisted snapshot alone.
 */
export class Session {
  readonly id: string
  readonly cwd: string
  readonly createdAt: number
  /** Session lifecycle state, owned by `beginRun`/`finishRun`. Read-only. */
  private _status: SessionStatus = "idle"
  /** The lifecycle state: `running` iff a run began and has not finished. */
  get status(): SessionStatus {
    return this._status
  }
  updatedAt: number
  /**
   * The durable conversation history. Owned by Session: it is mutated only
   * through Session's own append/rewrite/recovery operations. Exposed as a
   * read-only view so a caller cannot change durable history by mutating the
   * collection or a message returned from it.
   */
  private _messages: SessionMessage[] = []
  get messages(): readonly SessionMessage[] {
    return this._messages
  }
  /**
   * Every run this session has executed, oldest first. A run is appended when
   * it starts and replaced with its completed form when it ends, so a run
   * interrupted by a crash keeps a record of what was known before it died.
   *
   * Owned by `beginRun`/`finishRun`; the array is exposed read-only so no
   * caller can append or overwrite a record behind the lifecycle.
   */
  private readonly _runs: RunSummary[] = []
  get runs(): readonly RunSummary[] {
    return this._runs
  }
  /** User-visible session name (set via /name). */
  title: string | null = null
  /** Set when this session was forked/cloned from another session. */
  parentSessionId: string | null = null

  private readonly _ledger = new ToolLedger()
  get ledger(): ToolLedger {
    return this._ledger
  }

  /**
   * The identity of the active run, or null when none is active.
   *
   * In-memory only: a fresh process never has an active run (a persisted
   * `running` status is a crash artifact, not a live run), so this is not
   * serialized. It is the token that makes `finishRun` reject a stale or
   * double finalization.
   */
  private activeRunId: string | null = null

  private checkpointSink: (() => Promise<void>) | null = null
  private _needsRecovery = false
  private pendingRecoveryNote: string | null = null
  private pendingSteer: string | null = null

  private constructor(config: { id: string; cwd: string; createdAt?: number }) {
    this.id = config.id
    this.cwd = config.cwd
    this.createdAt = config.createdAt ?? Date.now()
    this.updatedAt = Date.now()
  }

  static create(config: { cwd: string; id?: string }): Session {
    return new Session({
      id: config.id ?? crypto.randomUUID(),
      cwd: config.cwd,
    })
  }

  static fromJSON(json: Record<string, unknown>): Session {
    const session = new Session({
      id: typeof json.id === "string" ? json.id : crypto.randomUUID(),
      cwd: typeof json.cwd === "string" ? json.cwd : process.cwd(),
      createdAt: typeof json.createdAt === "number" ? json.createdAt : undefined,
    })
    const persisted = json.status
    session._status = persisted === "running" || persisted === "interrupted" || persisted === "idle"
      ? persisted
      : "idle"
    session.updatedAt = typeof json.updatedAt === "number" ? json.updatedAt : 0
    if (typeof json.title === "string" && json.title.trim().length > 0) session.title = json.title
    if (typeof json.parentSessionId === "string") session.parentSessionId = json.parentSessionId
    session._messages.push(...parseMessages(json.messages))
    session._runs.push(...parseRuns(json.runs))
    session.ledger.replaceAll(ToolLedger.fromJSON(json.ledger as never))

    // A persisted 'running' status in a fresh process is always a crash
    // artifact: no run of ours is executing it anymore.
    if (session._status === "running") session._status = "interrupted"
    session._needsRecovery =
      session._status === "interrupted"
      || session.ledger.hasUnfinished()
    return session
  }

  toJSON(): Record<string, unknown> {
    return {
      version: 1,
      id: this.id,
      cwd: this.cwd,
      status: this._status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      title: this.title,
      parentSessionId: this.parentSessionId,
      runs: this._runs,
      ledger: this.ledger.toJSON(),
      messages: this._messages,
    }
  }

  /** Registers the single persistence sink (the runtime's store write). */
  onCheckpoint(fn: () => Promise<void>): void {
    this.checkpointSink = fn
  }

  /** Durability trigger: awaits the store write so callers know the
   *  current snapshot is on disk when this resolves. */
  async checkpoint(): Promise<void> {
    this.updatedAt = Date.now()
    await this.checkpointSink?.()
  }

  needsRecovery(): boolean {
    return this._needsRecovery
  }

  // ── run lifecycle ─────────────────────────────────────────────────

  /**
   * Starts the session's active run and makes its initial record durable.
   *
   * This is the only way to enter `running`: it establishes the run identity,
   * appends the run's initial `RunSummary`, transitions the session to
   * `running`, and checkpoints — in the same order the run layer used to do by
   * hand, so the durability contract is unchanged.
   *
   * A session has at most one active run. A second `beginRun` while one is
   * active is rejected: a runtime invariant, not a UI convention.
   */
  async beginRun(model: ModelIdentity): Promise<RunSummary> {
    if (this.activeRunId !== null) {
      throw new Error(`Session: a run is already active (${this.activeRunId})`)
    }
    const runId = crypto.randomUUID()
    const started: RunSummary = { id: runId, startedAt: Date.now(), model }
    this._runs.push(started)
    this.activeRunId = runId
    this._status = "running"
    await this.checkpoint()
    return started
  }

  /**
   * Finishes the active run and makes its terminal record durable.
   *
   * Only the active run identity may finish. A non-active or already-finished
   * identity is rejected, so a stale or double finalization cannot overwrite
   * the terminal record or change the session's lifecycle state. A normal
   * ending returns the session to `idle`; an abort leaves `interrupted` for the
   * next process to reconcile. Terminal persistence failure is swallowed so it
   * cannot mask the run outcome, matching the previous behavior.
   */
  async finishRun(runId: string, outcome: RunOutcome): Promise<RunSummary> {
    if (this.activeRunId === null || this.activeRunId !== runId) {
      throw new Error(`Session: run ${runId} is not the active run`)
    }
    const index = this._runs.findIndex(run => run.id === runId)
    if (index === -1) {
      throw new Error(`Session: no run record for ${runId}`)
    }
    const finished: RunSummary = {
      ...this._runs[index],
      finishedAt: Date.now(),
      finishReason: outcome.finishReason,
      usage: outcome.usage,
      modelCalls: outcome.modelCalls,
      toolCalls: outcome.toolCalls,
      ...(outcome.pruning === undefined ? {} : { pruning: outcome.pruning }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    }
    this._runs[index] = finished
    this.activeRunId = null
    this._status = outcome.aborted ? "interrupted" : "idle"
    try {
      await this.checkpoint()
    } catch {
      // Terminal persistence failure must not mask the run outcome.
    }
    return finished
  }

  // ── message lifecycle ─────────────────────────────────────────────

  pushUser(text: string): SessionMessage & { role: "user" } {
    const msg: SessionMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      status: "complete",
      timestamp: Date.now(),
    }
    this._messages.push(msg)
    return msg as SessionMessage & { role: "user" }
  }

  /** Appends a completed assistant turn built from a model response. */
  appendAssistant(
    content: ModelAssistantPart[],
    meta: { finishReason?: string },
  ): SessionMessage & { role: "assistant" } {
    const msg: SessionMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      status: "complete",
      timestamp: Date.now(),
      finishReason: meta.finishReason,
    }
    this._messages.push(msg)
    return msg as SessionMessage & { role: "assistant" }
  }

  /** The tool-result container for the assistant turn's calls: reuses the
   *  trailing tool message when present, else creates one. Created empty —
   *  results are appended per call, so a crash mid-execution leaves the
   *  durable history recoverable (see recover()). */
  toolResultMessageFor(assistantMsg: SessionMessage & { role: "assistant" }): SessionMessage & { role: "tool" } {
    const idx = this._messages.indexOf(assistantMsg)
    const next = this._messages[idx + 1]
    if (next !== undefined && next.role === "tool") {
      return next as SessionMessage & { role: "tool" }
    }
    const msg: SessionMessage = {
      id: crypto.randomUUID(),
      role: "tool",
      content: [],
      status: "complete",
      timestamp: Date.now(),
    }
    this._messages.splice(idx + 1, 0, msg)
    return msg as SessionMessage & { role: "tool" }
  }

  appendToolResult(toolMsg: SessionMessage & { role: "tool" }, result: ModelToolResult): void {
    ;(toolMsg.content as ModelToolResult[]).push(result)
  }

  /**
   * Records that this tool turn produced an observation a repair/debugging
   * loop may depend on (e.g. a command that ran and reported a non-zero exit
   * code). Durable, and honored by request-time pruning — see
   * `ToolMessage.failureEvidence`.
   */
  markFailureEvidence(toolMsg: SessionMessage & { role: "tool" }): void {
    ;(toolMsg as { failureEvidence?: boolean }).failureEvidence = true
  }

  /**
   * Records how to recover output ONE tool result no longer carries in full —
   * declared by whichever layer capped it. Keyed by `toolCallId`, so a turn
   * carrying several results keeps each one's recovery separate. Durable, and
   * honored by request-time pruning; see `ToolMessage.affordances`. Merged
   * within a key rather than replaced, so a tool's own offset survives the
   * canonical spill.
   */
  markAffordances(
    toolMsg: SessionMessage & { role: "tool" },
    toolCallId: string,
    affordances: ToolAffordances,
  ): void {
    const target = toolMsg as { affordances?: Record<string, ToolAffordances> }
    target.affordances = {
      ...target.affordances,
      [toolCallId]: { ...target.affordances?.[toolCallId], ...affordances },
    }
  }

  /** Finds the tool result recorded for a toolCallId, if any. */
  findToolResult(toolCallId: string): ModelToolResult | undefined {
    for (const msg of this._messages) {
      if (msg.role !== "tool") continue
      const found = msg.content.find(r => r.toolCallId === toolCallId)
      if (found) return found
    }
    return undefined
  }

  lastAssistant(): (SessionMessage & { role: "assistant" }) | undefined {
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const msg = this._messages[i]
      if (msg.role === "assistant") return msg as SessionMessage & { role: "assistant" }
      if (msg.role === "user") return undefined
    }
    return undefined
  }

  /** Queues a steering instruction: the active model stream is interrupted
   *  and the text becomes the next user message. Consumed by the loop. */
  steer(text: string): void {
    this.pendingSteer = text
  }

  /** Returns and clears a pending steering instruction, if any. */
  consumeSteer(): string | null {
    const text = this.pendingSteer
    this.pendingSteer = null
    return text
  }

  /** Sets the session title and persists. */
  async setTitle(title: string): Promise<void> {
    this.title = title
    await this.checkpoint()
  }

  /**
   * Canonical view for a `ModelRequest`: identities and statuses stripped, tool
   * outputs reduced only when the request would exceed its input budget
   * (serialization-time only — durable history is untouched).
   *
   * Callers that know the budget pass `context`; omitting it means no pressure
   * can be established, so nothing is reduced.
   */
  toRequestMessages(context?: PruneContext): ModelMessage[] {
    return pruneOldToolOutputs(
      this._messages.map(
        m =>
          ({
            role: m.role,
            content: m.content,
            ...(m.role === "tool" && m.failureEvidence === true ? { failureEvidence: true } : {}),
            ...(m.role === "tool" && m.affordances !== undefined ? { affordances: m.affordances } : {}),
          }) as ProjectionMessage,
      ),
      context,
    )
  }

  /**
   * Replaces the whole history and persists it.
   *
   * Every caller is a durable lifecycle change — compaction, import, fork,
   * clone — where the mutation *means* "change the durable session". So the
   * mutation owns its own durability, the way `setTitle` does, rather than
   * leaving it to each caller to remember a `checkpoint()`. Requiring that
   * step is what let `/fork`, `/clone`, `/import` and `/compact` return having
   * changed only memory: the new session stayed invisible on disk until some
   * later run happened to checkpoint, and was lost outright if the process
   * exited first.
   *
   * This is deliberately NOT a general autosave: per-message appends during a
   * run are ephemeral runtime state whose durability is the Run's business,
   * ordered around its recovery contract. Only this wholesale rewrite — which
   * no run path performs for durability reasons — persists itself.
   *
   * The candidate history is validated before anything is mutated: an invalid
   * replacement throws and leaves the existing history and the on-disk snapshot
   * untouched. A valid replacement is swapped in atomically, then checkpointed.
   */
  async replaceMessages(messages: readonly ModelMessage[]): Promise<void> {
    validateReplacementHistory(messages)
    const next: SessionMessage[] = messages.map(message => ({
      id: crypto.randomUUID(),
      ...message,
      status: "complete",
      timestamp: Date.now(),
    } as SessionMessage))
    this._messages = next
    await this.checkpoint()
  }

  /** Consume the pending recovery note (exactly the next model context). */
  takeRecoveryNote(): string | null {
    const note = this.pendingRecoveryNote
    this.pendingRecoveryNote = null
    return note
  }

  // ── crash recovery ────────────────────────────────────────────────

  /**
   * Reconciles an interrupted run so execution can resume deterministically:
   * - `pending` ledger entries are reissued with the SAME toolCallId
   * - `running` entries had an unknown outcome: idempotent tools are
   *   reissued, everything else gets an injected failed tool result
   * - dangling tool-call parts (no result, no ledger entry) get the same
   *   unknown-outcome treatment
   * - a recovery note is prepared for the next model context
   *
   * Never fabricates success: unknown outcomes stay unknown.
   */
  async recover(hooks?: RecoverHooks): Promise<RecoveryReport> {
    if (!this._needsRecovery) return EMPTY_REPORT

    const report: RecoveryReport = { recovered: true, reissued: [], unknownOutcome: [], note: "" }

    // 1. Running entries: unknown outcome — reissue only idempotent tools.
    for (const entry of [...this.ledger.all]) {
      if (entry.status !== "running") continue
      const tool = hooks?.tools?.get(entry.name)
      if (tool?.idempotent === true) {
        this.ledger.reissue(entry.toolCallId, "previous outcome unknown; idempotent tool reissued after restart")
        report.unknownOutcome.push({ toolCallId: entry.toolCallId, name: entry.name, resolved: "idempotent-reissue" })
      } else {
        this.injectUnknownOutcome(entry.toolCallId, entry.name)
        report.unknownOutcome.push({ toolCallId: entry.toolCallId, name: entry.name, resolved: "injected-failed-result" })
      }
    }

    // 2. Dangling tool-call parts: a call in history with no result and no
    //    ledger entry is an unknown outcome.
    for (const msg of this._messages) {
      if (msg.role !== "assistant") continue
      for (const part of msg.content) {
        if (part.type !== "tool_call") continue
        const hasResult = this.findToolResult(part.toolCallId) !== undefined
        const hasLedger = this.ledger.get(part.toolCallId) !== undefined
        if (!hasResult && !hasLedger) {
          this.injectUnknownOutcome(part.toolCallId, part.toolName)
          report.unknownOutcome.push({ toolCallId: part.toolCallId, name: part.toolName, resolved: "injected-failed-result" })
        }
      }
    }

    // 3. Reissue pending calls with the same toolCallId so the model sees
    //    a completed turn before continuing.
    for (const entry of [...this.ledger.all]) {
      if (entry.status !== "pending") continue
      const assistantMsg = this.findAssistantWithCall(entry.toolCallId)
      if (assistantMsg !== undefined && hooks?.executeTool !== undefined) {
        // The ledger entry exposes a read-only `input`; hand execution its own
        // mutable copy so the reissue path keeps its `Record` contract without
        // the ledger handing out a mutable reference.
        await hooks.executeTool(this, assistantMsg, entry.name, entry.toolCallId, { ...entry.input }, { reissue: true })
        report.reissued.push({ toolCallId: entry.toolCallId, name: entry.name })
      } else {
        // Orphaned entry — finalize defensively.
        this.injectUnknownOutcome(entry.toolCallId, entry.name)
        report.unknownOutcome.push({ toolCallId: entry.toolCallId, name: entry.name, resolved: "injected-failed-result" })
        this.ledger.finished(entry.toolCallId, "failed", { note: "orphaned ledger entry" })
      }
    }

    this._needsRecovery = false
    report.note = buildRecoveryNote(report)
    this.pendingRecoveryNote = report.note
    await this.checkpoint()
    return report
  }

  private injectUnknownOutcome(toolCallId: string, name: string): void {
    const assistantMsg = this.findAssistantWithCall(toolCallId)
    if (assistantMsg === undefined) return
    const toolMsg = this.toolResultMessageFor(assistantMsg)
    if (this.findToolResult(toolCallId) === undefined) {
      this.appendToolResult(toolMsg, {
        toolCallId,
        toolName: name,
        output: { type: "tool_error", text: UNKNOWN_OUTCOME_ERROR },
      })
    }
    // Dangling calls may have no ledger entry at all — create one so the
    // outcome is recorded.
    if (this.ledger.get(toolCallId) === undefined) {
      this.ledger.pending({ toolCallId, name, input: {} })
    }
    // The outcome is unknown, and so is the interval: a start recorded before
    // the restart does not bound an invocation that never finished. Erase it
    // rather than leave a pair whose difference would read as a duration
    // spanning the downtime.
    this.ledger.finished(toolCallId, "failed", {
      note: UNKNOWN_OUTCOME_ERROR,
      startedAt: undefined,
    })
  }

  private findAssistantWithCall(toolCallId: string): (SessionMessage & { role: "assistant" }) | undefined {
    for (const msg of this._messages) {
      if (msg.role !== "assistant") continue
      if (msg.content.some(p => p.type === "tool_call" && p.toolCallId === toolCallId)) {
        return msg as SessionMessage & { role: "assistant" }
      }
    }
    return undefined
  }
}

function parseMessages(input: unknown): SessionMessage[] {
  if (!Array.isArray(input)) return []
  const out: SessionMessage[] = []
  for (const raw of input) {
    const msg = raw as Partial<SessionMessage>
    if (typeof msg !== "object" || msg === null) continue
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "tool") continue
    out.push({
      ...msg,
      id: typeof msg.id === "string" ? msg.id : crypto.randomUUID(),
      status: "complete",
      timestamp: typeof msg.timestamp === "number" ? msg.timestamp : 0,
    } as SessionMessage)
  }
  return out
}

/**
 * Validates a candidate history for {@link Session.replaceMessages}.
 *
 * `replaceMessages` is the durable rewrite door used by compaction, fork,
 * clone and `/import`. It accepts `ModelMessage[]`, a shape that admits roles
 * and payloads the durable format cannot faithfully represent (the loader's
 * `parseMessages` silently drops any role but user/assistant/tool). Anything
 * accepted here must round-trip through `toJSON`/`fromJSON` unchanged, so the
 * rules below reject exactly what the durable format cannot carry:
 *
 *  - roles must be one of `user`, `assistant`, `tool`;
 *  - each message must have the declared shape for its role (string user
 *    content; assistant parts; tool results with a known output kind);
 *  - a tool call/result `toolCallId` must be a non-empty string;
 *  - one `toolCallId` may have at most one durable result.
 *
 * A dangling assistant tool call (no result) is deliberately valid: interrupted
 * and steered runs leave exactly that, and `recover` reconciles it. Validation
 * therefore never requires a call to have a result.
 *
 * Throws before any mutation; callers must treat a throw as "nothing changed".
 */
function validateReplacementHistory(messages: readonly ModelMessage[]): void {
  const seenResultIds = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as { role?: unknown } | null | undefined
    if (typeof message !== "object" || message === null) {
      throw new Error(`replaceMessages: message ${i} is not an object`)
    }
    if (message.role === "user") {
      if (typeof (message as { content?: unknown }).content !== "string") {
        throw new Error(`replaceMessages: user message ${i} content must be a string`)
      }
      continue
    }
    if (message.role === "assistant") {
      const content = (message as { content?: unknown }).content
      // A plain string is the transcript form `/import` accepts and the
      // durable loader preserves verbatim; parts are the runtime form.
      if (typeof content === "string") continue
      if (!Array.isArray(content)) {
        throw new Error(`replaceMessages: assistant message ${i} content must be a string or an array of parts`)
      }
      content.forEach((raw, p) => {
        const part = raw as { type?: unknown; text?: unknown; toolCallId?: unknown; toolName?: unknown } | null
        if (part === null || typeof part !== "object") {
          throw new Error(`replaceMessages: assistant message ${i} part ${p} is not an object`)
        }
        if (part.type === "text") {
          if (typeof part.text !== "string") {
            throw new Error(`replaceMessages: assistant message ${i} text part ${p} needs a string text`)
          }
        } else if (part.type === "tool_call") {
          if (typeof part.toolCallId !== "string" || part.toolCallId.length === 0) {
            throw new Error(`replaceMessages: assistant message ${i} tool call ${p} needs a non-empty toolCallId`)
          }
          if (typeof part.toolName !== "string") {
            throw new Error(`replaceMessages: assistant message ${i} tool call ${p} needs a toolName`)
          }
        } else {
          throw new Error(`replaceMessages: assistant message ${i} part ${p} has an unsupported type`)
        }
      })
      continue
    }
    if (message.role === "tool") {
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) {
        throw new Error(`replaceMessages: tool message ${i} content must be an array`)
      }
      content.forEach((raw, r) => {
        const result = raw as { toolCallId?: unknown; toolName?: unknown; output?: unknown } | null
        if (result === null || typeof result !== "object") {
          throw new Error(`replaceMessages: tool message ${i} result ${r} is not an object`)
        }
        if (typeof result.toolCallId !== "string" || result.toolCallId.length === 0) {
          throw new Error(`replaceMessages: tool message ${i} result ${r} needs a non-empty toolCallId`)
        }
        if (seenResultIds.has(result.toolCallId)) {
          throw new Error(`replaceMessages: duplicate tool result for toolCallId ${result.toolCallId}`)
        }
        seenResultIds.add(result.toolCallId)
        if (typeof result.toolName !== "string") {
          throw new Error(`replaceMessages: tool message ${i} result ${r} needs a toolName`)
        }
        const output = result.output as { type?: unknown; text?: unknown } | null | undefined
        if (output === null || typeof output !== "object") {
          throw new Error(`replaceMessages: tool message ${i} result ${r} needs an output`)
        }
        if (output.type === "text" || output.type === "tool_error") {
          if (typeof output.text !== "string") {
            throw new Error(`replaceMessages: tool message ${i} result ${r} ${output.type} output needs a string text`)
          }
        } else if (output.type !== "json") {
          throw new Error(`replaceMessages: tool message ${i} result ${r} has an unsupported output type`)
        }
      })
      continue
    }
    throw new Error(`replaceMessages: message ${i} has unsupported durable role ${String(message.role)}`)
  }
}

/** Parses persisted run records; anything malformed is skipped rather than
 *  failing the whole session load. */
function parseRuns(input: unknown): RunSummary[] {
  if (!Array.isArray(input)) return []
  const out: RunSummary[] = []
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue
    const run = raw as Partial<RunSummary>
    const model = run.model as Partial<ModelIdentity> | undefined
    if (typeof run.id !== "string" || typeof run.startedAt !== "number") continue
    if (typeof model !== "object" || model === null || typeof model.id !== "string") continue
    out.push(raw as RunSummary)
  }
  return out
}

function buildRecoveryNote(report: RecoveryReport): string {
  const lines: string[] = [
    "RECOVERY — this session was interrupted and has been reconciled automatically.",
  ]
  if (report.reissued.length > 0) {
    lines.push(`- Pending tool calls reissued (same toolCallId): ${report.reissued.map(t => t.name).join(", ")}.`)
  }
  const reissued = report.unknownOutcome.filter(t => t.resolved === "idempotent-reissue")
  if (reissued.length > 0) {
    lines.push(`- Tool calls with unknown outcome re-executed (idempotent): ${reissued.map(t => t.name).join(", ")}.`)
  }
  const injected = report.unknownOutcome.filter(t => t.resolved === "injected-failed-result")
  if (injected.length > 0) {
    lines.push(`- Tool calls with unknown outcome recorded as failed ("${UNKNOWN_OUTCOME_ERROR}"): ${injected.map(t => t.name).join(", ")}. Do NOT assume they completed.`)
  }
  return lines.join("\n")
}
