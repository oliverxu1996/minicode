export type ToolLedgerStatus = "pending" | "running" | "succeeded" | "failed"

export interface ToolLedgerEntry {
  toolCallId: string
  name: string
  input: Record<string, unknown>
  status: ToolLedgerStatus
  startedAt?: number
  finishedAt?: number
  note?: string
}

/**
 * Durable record of every tool invocation in a session.
 *
 * Explicit transitions:
 *
 *     pending ──► running ──► succeeded / failed
 *
 * Gate outcomes would finalize directly from `pending`; v0.1 auto-approves
 * every tool, so that path is unused but the state machine keeps it
 * available. The caller (Run/executeTool) enforces the ordering invariant:
 * a tool must not execute until its `pending` entry is durably persisted,
 * and the result must not be recorded before the entry is `running`.
 *
 */
export class ToolLedger {
  private entries: ToolLedgerEntry[] = []

  get all(): ToolLedgerEntry[] {
    return this.entries
  }

  /** Record a requested tool call as pending. A reissued call (same
   *  toolCallId, still pending after recovery) is a no-op; any other
   *  duplicate is an error. */
  pending(entry: { toolCallId: string; name: string; input: Record<string, unknown> }): void {
    const existing = this.entries.find(e => e.toolCallId === entry.toolCallId)
    if (existing) {
      if (existing.status === "pending") return // recovery reissue
      throw new Error(`ToolLedger: toolCallId ${entry.toolCallId} already exists (status ${existing.status})`)
    }
    this.entries.push({ status: "pending", ...entry })
  }

  /** Transition a pending entry to running. */
  running(toolCallId: string, meta: { startedAt?: number } = {}): void {
    const entry = this.require(toolCallId)
    if (entry.status !== "pending") {
      throw new Error(`ToolLedger: cannot start ${toolCallId} from status ${entry.status}`)
    }
    entry.status = "running"
    entry.startedAt = meta.startedAt ?? Date.now()
  }

  /** Re-arm a running entry as pending for automatic retry. Only for
   *  explicitly idempotent tools: the previous outcome is unknown and is
   *  recorded in the note — never fabricate success or failure. */
  reissue(toolCallId: string, note?: string): void {
    const entry = this.require(toolCallId)
    if (entry.status !== "running") {
      throw new Error(`ToolLedger: cannot reissue ${toolCallId} from status ${entry.status}`)
    }
    entry.status = "pending"
    entry.startedAt = undefined
    entry.finishedAt = undefined
    if (note !== undefined) entry.note = note
  }

  /** Finalize an entry as succeeded or failed. A final state is terminal. */
  finished(
    toolCallId: string,
    outcome: "succeeded" | "failed",
    meta: { finishedAt?: number; note?: string } = {},
  ): void {
    const entry = this.require(toolCallId)
    if (entry.status !== "running" && entry.status !== "pending") {
      throw new Error(`ToolLedger: cannot finish ${toolCallId} from status ${entry.status}`)
    }
    entry.status = outcome
    entry.finishedAt = meta.finishedAt ?? Date.now()
    if (meta.note !== undefined) entry.note = meta.note
  }

  get(toolCallId: string): ToolLedgerEntry | undefined {
    return this.entries.find(e => e.toolCallId === toolCallId)
  }

  /** True when any entry is still pending or running — the signature of an
   *  interrupted run. */
  hasUnfinished(): boolean {
    return this.entries.some(e => e.status === "pending" || e.status === "running")
  }

  toJSON(): ToolLedgerEntry[] {
    return this.entries.map(e => ({ ...e }))
  }

  static fromJSON(entries: ToolLedgerEntry[] | undefined | null): ToolLedger {
    const ledger = new ToolLedger()
    ledger.entries = (entries ?? []).map(e => ({ ...e, input: { ...(e.input ?? {}) } }))
    return ledger
  }

  /** Replaces all entries (used when loading a persisted ledger). */
  replaceAll(ledger: ToolLedger): void {
    this.entries = ledger.entries
  }

  private require(toolCallId: string): ToolLedgerEntry {
    const entry = this.entries.find(e => e.toolCallId === toolCallId)
    if (!entry) throw new Error(`ToolLedger: no entry for toolCallId ${toolCallId}`)
    return entry
  }
}
