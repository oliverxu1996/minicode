/**
 * `@minicode/agent` — the MiniCode Coding Agent runtime.
 *
 * Public surface: the `MiniCode` runtime root (session lifecycle + the
 * autonomous `run()` door), the durable session types, the configuration
 * adapters, and the context-budget and compaction capabilities the
 * application composes. Tools and the loop are internal details of `run()`.
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
  ModelIdentity,
  RunEvent,
  RunFinishReason,
  RunSummary,
  SessionMessage,
  SessionMessageStatus,
  SessionStatus,
  ToolMessage,
  UserMessage,
} from "./session/types"
export { Compactor, type CompactionOutcome } from "./loop/compact"
export { loadSettings } from "./config/settings"
export { loadResources, type PromptTemplate, type Skill } from "./config/resources"
export { isProjectTrusted, trustProject } from "./config/trust"
export { IGNORED_WORKSPACE_ENTRIES } from "./workspace-ignored"
export { CODING_TOOLS, type Tool, type ToolExecutionContext, type ToolResult } from "./tools"
