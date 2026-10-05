import type { ModelAssistantPart, ModelMessage, ModelToolResult, ModelUsage } from "@minicode/model"
import type { ModelIdentity, RunSummary, SessionMessage, SessionStatus } from "./types"
import { ToolLedger } from "./ledger"
import { pruneOldToolOutputs } from "./prune"
import type { PruneContext, ProjectionMessage } from "./prune"

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
  status: SessionStatus = "idle"
  updatedAt: number
  readonly messages: SessionMessage[] = []
  /**
   * Every run this session has executed, oldest first. A run is appended when
   * it starts and replaced with its completed form when it ends, so a run
   * interrupted by a crash keeps a record of what was known before it died.
   */
  readonly runs: RunSummary[] = []
  /** User-visible session name (set via /name). */
  title: string | null = null
  /** Set when this session was forked/cloned from another session. */
  parentSessionId: string | null = null

  private readonly _ledger = new ToolLedger()
  get ledger(): ToolLedger {
    return this._ledger
  }

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
    session.status = persisted === "running" || persisted === "interrupted" || persisted === "idle"
      ? persisted
      : "idle"
    session.updatedAt = typeof json.updatedAt === "number" ? json.updatedAt : 0
    if (typeof json.title === "string" && json.title.trim().length > 0) session.title = json.title
    if (typeof json.parentSessionId === "string") session.parentSessionId = json.parentSessionId
    session.messages.push(...parseMessages(json.messages))
    session.runs.push(...parseRuns(json.runs))
    session.ledger.replaceAll(ToolLedger.fromJSON(json.ledger as never))

    // A persisted 'running' status in a fresh process is always a crash
    // artifact: no run of ours is executing it anymore.
    if (session.status === "running") session.status = "interrupted"
    session._needsRecovery =
      session.status === "interrupted"
      || session.ledger.hasUnfinished()
    return session
  }

  toJSON(): Record<string, unknown> {
    return {
      version: 1,
      id: this.id,
      cwd: this.cwd,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      title: this.title,
      parentSessionId: this.parentSessionId,
      runs: this.runs,
      ledger: this.ledger.toJSON(),
      messages: this.messages,
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

  // ── message lifecycle ─────────────────────────────────────────────

  pushUser(text: string): SessionMessage & { role: "user" } {
    const msg: SessionMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      status: "complete",
      timestamp: Date.now(),
    }
    this.messages.push(msg)
    return msg as SessionMessage & { role: "user" }
  }

  /** Appends a completed assistant turn built from a model response. */
  appendAssistant(
    content: ModelAssistantPart[],
    meta: { usage?: ModelUsage; finishReason?: string },
  ): SessionMessage & { role: "assistant" } {
    const msg: SessionMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      status: "complete",
      timestamp: Date.now(),
      usage: meta.usage,
      finishReason: meta.finishReason,
    }
    this.messages.push(msg)
    return msg as SessionMessage & { role: "assistant" }
  }

  /** The tool-result container for the assistant turn's calls: reuses the
   *  trailing tool message when present, else creates one. Created empty —
   *  results are appended per call, so a crash mid-execution leaves the
   *  durable history recoverable (see recover()). */
  toolResultMessageFor(assistantMsg: SessionMessage & { role: "assistant" }): SessionMessage & { role: "tool" } {
    const idx = this.messages.indexOf(assistantMsg)
    const next = this.messages[idx + 1]
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
    this.messages.splice(idx + 1, 0, msg)
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

  /** Finds the tool result recorded for a toolCallId, if any. */
  findToolResult(toolCallId: string): ModelToolResult | undefined {
    for (const msg of this.messages) {
      if (msg.role !== "tool") continue
      const found = msg.content.find(r => r.toolCallId === toolCallId)
      if (found) return found
    }
    return undefined
  }

  lastAssistant(): (SessionMessage & { role: "assistant" }) | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]
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
      this.messages.map(
        m =>
          ({
            role: m.role,
            content: m.content,
            ...(m.role === "tool" && m.failureEvidence === true ? { failureEvidence: true } : {}),
          }) as ProjectionMessage,
      ),
      context,
    )
  }

  /** Replaces the whole history (used by compaction). The caller
   *  checkpoints. */
  replaceMessages(messages: ModelMessage[]): void {
    this.messages.length = 0
    for (const message of messages) {
      this.messages.push({
        id: crypto.randomUUID(),
        ...message,
        status: "complete",
        timestamp: Date.now(),
      } as SessionMessage)
    }
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
    for (const msg of this.messages) {
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
        await hooks.executeTool(this, assistantMsg, entry.name, entry.toolCallId, entry.input, { reissue: true })
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
    for (const msg of this.messages) {
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
