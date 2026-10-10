import type { ModelAssistantPart, ModelMessage, ModelToolResult, ModelUsage } from "@minicode/model"
import type { ModelIdentity, RewindNote, RunFinishReason, RunSummary, SessionMessage, SessionStatus } from "./types"
import { ToolLedger } from "./ledger"
import { parseMessages, parseRewindNote, parseRuns, validateReplacementHistory } from "./serialization"
import { pruneOldToolOutputs } from "../context/projection"
import type { PruneContext, PruneStats, ProjectionMessage } from "../context/projection"
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
  /**
   * Shell activity this session's rewinds discarded and did not undo.
   *
   * Persisted with the session so the warning survives a reload — the shell's
   * effects do. Owned by `recordRewind`, which only ever adds to it.
   */
  rewind: RewindNote | null = null

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
    session.rewind = parseRewindNote(json.rewind)
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
      rewind: this.rewind,
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
    // Snapshot everything this call will mutate, so a failed initial
    // checkpoint cannot leave the session holding a run it never durably
    // established.
    const prevStatus = this._status
    const prevUpdatedAt = this.updatedAt
    this._runs.push(started)
    this.activeRunId = runId
    this._status = "running"
    try {
      await this.checkpoint()
    } catch (err) {
      // Roll back every mutation made above: a start that could not be made
      // durable must not strand the session in an active run.
      this._runs.pop()
      this.activeRunId = null
      this._status = prevStatus
      this.updatedAt = prevUpdatedAt
      throw err
    }
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

  /**
   * Appends a user message.
   *
   * `turnId` is supplied only by the run loop, which mints it once and gives
   * the same value to the rewind recorder, so a checkpoint and the message it
   * describes can never disagree. Everything else that appends a user message
   * — a steer note, a summary, an imported transcript — is not a turn start
   * and deliberately carries no identity.
   */
  pushUser(text: string, turnId?: string): SessionMessage & { role: "user" } {
    const msg: SessionMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      ...(turnId === undefined ? {} : { turnId }),
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
  async replaceMessages(messages: readonly (ModelMessage & { turnId?: string })[]): Promise<void> {
    validateReplacementHistory(messages)
    // The spread carries whatever durable-only metadata the caller preserved —
    // notably `turnId`, which identifies the turn a checkpoint belongs to and
    // so must outlive the rewrite. Ids and timestamps are regenerated as
    // before; a caller that drops `turnId` invalidates that turn's
    // checkpoints, which is the safe direction.
    const next: SessionMessage[] = messages.map(message => ({
      id: crypto.randomUUID(),
      ...message,
      status: "complete",
      timestamp: Date.now(),
    } as SessionMessage))
    this._messages = next
    await this.checkpoint()
  }

  /**
   * Drops the interrupt/recovery latches.
   *
   * Used by `/rewind`: those latches describe history that has just been
   * discarded, and leaving them set would make the next run report a recovery
   * for a turn the user deliberately removed.
   */
  forgetInterruptedState(): void {
    this._needsRecovery = false
    this.pendingRecoveryNote = null
    this.pendingSteer = null
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
    // This pass is the model-request boundary's reconciliation, so it runs
    // unconditionally rather than trusting the advisory `_needsRecovery`
    // latch: a dangling call can be present while the latch is false (see
    // `replaceMessages`). It is idempotent and reports `recovered` only when
    // it actually changed something.
    const report: RecoveryReport = { recovered: false, reissued: [], unknownOutcome: [], note: "" }

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
        // No execution hook (or no assistant call to attach the outcome to):
        // reconcile the pending invocation to an unknown terminal outcome
        // rather than re-executing it.
        this.injectUnknownOutcome(entry.toolCallId, entry.name)
        report.unknownOutcome.push({ toolCallId: entry.toolCallId, name: entry.name, resolved: "injected-failed-result" })
        // `injectUnknownOutcome` already finalizes an entry that has a
        // matching call in history; only a true orphan (no assistant call) is
        // left for this defensive finalization. Guard so one invocation is
        // never terminalized twice.
        const current = this.ledger.get(entry.toolCallId)
        if (current?.status === "pending" || current?.status === "running") {
          this.ledger.finished(entry.toolCallId, "failed", { note: "orphaned ledger entry" })
        }
      }
    }

    const didWork = report.reissued.length > 0 || report.unknownOutcome.length > 0
    if (!didWork && !this._needsRecovery) return EMPTY_REPORT

    // Nothing is pending acknowledgement once a pass has run: clear the
    // advisory latch. A flagged session with no execution state left to
    // reconcile (e.g. an abort before any tool ran) is acknowledged silently —
    // no note, no durable change, no recovery event.
    this._needsRecovery = false
    if (!didWork) return EMPTY_REPORT

    report.recovered = true
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
