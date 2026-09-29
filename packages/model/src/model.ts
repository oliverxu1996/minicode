import { AISDKRuntime } from "./runtime/ai-sdk"
import type {
  Model,
  ModelConfig,
  ModelEvent,
  ModelProtocol,
  ModelRequest,
  ModelResponse,
} from "./types"

/**
 * Internal {@link Model} implementation: identity and limits are public,
 * invocation is delegated to the protocol runtime.
 *
 * The boundary is identity, not configuration. `id`, `name`, `protocol`,
 * `model` and `limits` say *which* model this is, and may cross the package
 * boundary so a run can record what produced it. Everything else — the
 * endpoint, the API key, and the runtime holding them — stays inside.
 */
class ConcreteModel implements Model {
  readonly id: string
  readonly name: string
  readonly protocol: ModelProtocol
  readonly model: string
  readonly limits: Model["limits"]

  // True private field: invisible to consumers inspecting the object.
  readonly #runtime: AISDKRuntime

  constructor(config: ModelConfig) {
    this.id = config.id
    this.name = config.name
    this.protocol = config.protocol
    this.model = config.model
    this.limits = {
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
    }
    this.#runtime = new AISDKRuntime(config)
  }

  generate(request: ModelRequest): Promise<ModelResponse> {
    return this.#runtime.generate(request)
  }

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    return this.#runtime.stream(request)
  }
}

/** Creates the callable model for a validated configuration. Internal. */
export function createModel(config: ModelConfig): Model {
  return Object.freeze(new ConcreteModel(config))
}
