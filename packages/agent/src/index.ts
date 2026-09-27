/**
 * `@minicode/agent` — the MiniCode Coding Agent runtime.
 *
 * Public surface: the `MiniCode` runtime root (session lifecycle + the
 * autonomous `run()` door), the durable session types, and the Runtime-owned
 * 75/25 context-budget helper. Tools and the loop are internal details of
 * `run()`.
 */

export { contextBudget } from "./context-budget"
export type { ContextBudget } from "./context-budget"
export { MiniCode } from "./minicode"
export type { MiniCodeOptions, RunResult } from "./minicode"
export { Session, UNKNOWN_OUTCOME_ERROR, type RecoveryReport } from "./session/session"
export { SessionStore } from "./session/store"
export { ToolLedger, type ToolLedgerEntry, type ToolLedgerStatus } from "./session/ledger"
export type {
  AssistantMessage,
  RunEvent,
  RunFinishReason,
  SessionMessage,
  SessionMessageStatus,
  SessionStatus,
  ToolMessage,
  UserMessage,
} from "./session/types"
export { CODING_TOOLS, type Tool, type ToolExecutionContext, type ToolResult } from "./tools"
