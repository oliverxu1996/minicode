/**
 * `@loongcode/agent` — the LoongCode Coding Agent runtime.
 *
 * Public surface: the `LoongCode` runtime root (session lifecycle + the
 * autonomous `run()` door), the durable session types, the configuration
 * adapters, and the context-budget and compaction capabilities the
 * application composes. Tools and the loop are internal details of `run()`.
 */

export { contextBudget } from "./context/budget"
export type { ContextBudget } from "./context/budget"
export { LoongCode } from "./loongcode"
export type { LoongCodeOptions, RunResult } from "./loongcode"
export { Session, UNKNOWN_OUTCOME_ERROR, type RecoveryReport } from "./session/session"
export { SessionStore } from "./session/store"
export { ToolLedger, type ToolLedgerEntry, type ToolLedgerStatus } from "./session/ledger"
export type { RunEvent } from "./loop/events"
export type {
  AssistantMessage,
  ModelIdentity,
  RunFinishReason,
  RunSummary,
  SessionMessage,
  SessionMessageStatus,
  SessionStatus,
  ToolMessage,
  UserMessage,
} from "./session/types"
export { Compactor, type CompactionOutcome } from "./context/compaction"
export { configDir } from "./config/dir"
export { loadSettings } from "./config/settings"
export {
  loadResources,
  listPromptTemplates,
  type PromptTemplate,
  type PromptTemplateSummary,
  type Skill,
} from "./config/resources"
export { IGNORED_WORKSPACE_ENTRIES } from "./workspace-ignored"
export { CODING_TOOLS, type Tool, type ToolExecutionContext, type ToolResult } from "./tools"
export { CheckpointStore, RewindRecorder, restoreFiles, resolveInWorkspace, readFileState, isShellTool, mutationTargets, checkpointsPath, type Checkpoint, type FileChange, type FileState, type RestoreOutcome } from "./session/checkpoint"
export { rewindSession, summarizeRange, isLiveCheckpoint, liveCheckpoints, turnIndexOf, discardTurns, recordRewind, type CheckpointAdvance, type RewindScope, type RewindOutcome } from "./session/rewind"
export type { RewindNote } from "./session/types"
