/**
 * `@minicode/model` — model configuration, lifecycle, active-model
 * selection, and normalized model invocation for MiniCode.
 *
 * Public surface: {@link ModelManager} (owns configurations and the active
 * model) and {@link Model} (a concrete callable model), plus the canonical
 * message protocol. Protocol adapters, the AI SDK, and persistence are
 * implementation details behind this entry point.
 */

export { ModelManager } from "./manager"
export { ModelError } from "./errors"
export type { ModelErrorCode } from "./errors"
export type {
  Model,
  ModelAssistantPart,
  ModelConfig,
  ModelEvent,
  ModelFinishReason,
  ModelLimits,
  ModelMessage,
  ModelMessageRole,
  ModelProtocol,
  ModelRequest,
  ModelResponse,
  ModelTextPart,
  ModelTool,
  ModelToolCall,
  ModelToolCallPart,
  ModelToolOutput,
  ModelToolResult,
  ModelUsage,
} from "./types"
