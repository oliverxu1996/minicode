import { validateModelConfig } from "./config"
import { configurationError } from "./errors"
import { createModel } from "./model"
import { loadState, saveState } from "./persistence"
import type { Model, ModelConfig } from "./types"

/**
 * Owns the configured models: CRUD, active-model selection, and lifecycle.
 *
 * Every model configuration lives in a local JSON file; mutations validate,
 * persist atomically, and only then update in-memory state — there is no
 * separate `save()` step. Errors on invalid input or failed persistence are
 * thrown and leave the manager unchanged.
 *
 * Identifiers are trimmed when written, and lookups compare trimmed
 * identifiers.
 */
export class ModelManager {
  /** Source of truth; the model cache mirrors it one-to-one. */
  private configs = new Map<string, ModelConfig>()
  private models = new Map<string, Model>()
  private activeModelId: string | null = null

  /**
   * Loads the manager from the local configuration file.
   *
   * A missing file yields an empty manager. A malformed or invalid file
   * throws a `configuration_error` — the file is never silently replaced.
   */
  static async load(): Promise<ModelManager> {
    const state = loadState()
    const manager = new ModelManager()
    for (const config of state.models) {
      manager.configs.set(config.id, config)
      manager.models.set(config.id, createModel(config))
    }
    manager.activeModelId = state.activeModelId
    return manager
  }

  private constructor() {}

  /** All configured models, in configuration order. */
  list(): readonly Model[] {
    return [...this.configs.keys()].map(id => this.models.get(id)!)
  }

  /** The model with the given id, or `undefined` when it does not exist. */
  get(id: string): Model | undefined {
    return this.models.get(id.trim())
  }

  /**
   * A defensive copy of the stored configuration for `id`, or `undefined` when
   * it is not configured.
   *
   * Exists so an edit flow can seed its prompts with the current values —
   * including the endpoint and API key that {@link Model} deliberately hides —
   * without exposing the manager's internal map. The returned object is a copy:
   * mutating it cannot change the manager.
   */
  config(id: string): ModelConfig | undefined {
    const config = this.configs.get(id.trim())
    return config === undefined ? undefined : { ...config }
  }

  /**
   * Adds a model configuration. The configuration is validated, the id must
   * be unique, and the change is persisted before returning.
   *
   * The first model added becomes the active model.
   */
  add(config: ModelConfig): Model {
    const validated = this.validate(config)

    if (this.configs.has(validated.id)) {
      throw configurationError(`model id "${validated.id}" is already configured`)
    }

    const next = new Map(this.configs)
    next.set(validated.id, validated)
    const nextActive = this.configs.size === 0 ? validated.id : this.activeModelId
    this.commit(next, nextActive, { id: validated.id, config: validated })
    return this.models.get(validated.id)!
  }

  /**
   * Replaces the configuration of an existing model wholesale — this is a
   * replacement, not a patch. The change is persisted before returning.
   */
  update(config: ModelConfig): Model {
    const validated = this.validate(config)

    if (!this.configs.has(validated.id)) {
      throw configurationError(`model "${validated.id}" is not configured`)
    }

    const next = new Map(this.configs)
    next.set(validated.id, validated)
    this.commit(next, this.activeModelId, { id: validated.id, config: validated })
    return this.models.get(validated.id)!
  }

  /**
   * Removes a model. If the removed model was active, no model is active
   * afterwards; another model is never auto-selected.
   */
  remove(id: string): void {
    const key = id.trim()
    if (!this.configs.has(key)) {
      throw configurationError(`model "${key}" is not configured`)
    }

    const next = new Map(this.configs)
    next.delete(key)
    const nextActive = this.activeModelId === key ? null : this.activeModelId
    this.commit(next, nextActive, { id: key })
  }

  /** Makes the model with the given id the active model. */
  activate(id: string): void {
    const key = id.trim()
    if (!this.configs.has(key)) {
      throw configurationError(`model "${key}" is not configured`)
    }
    this.commit(this.configs, key)
  }

  /** The active model, or `undefined` when no model is active. */
  active(): Model | undefined {
    return this.activeModelId === null ? undefined : this.get(this.activeModelId)
  }

  private validate(config: ModelConfig): ModelConfig {
    return validateModelConfig(config, "model configuration")
  }

  /**
   * Persists the next state and only then commits it to memory: a failed
   * write leaves the manager exactly as it was, so memory and file can never
   * disagree about the last mutation.
   */
  private commit(
    configs: Map<string, ModelConfig>,
    activeModelId: string | null,
    changed?: { id: string; config?: ModelConfig },
  ): void {
    saveState([...configs.values()], activeModelId)
    this.configs = configs
    this.activeModelId = activeModelId
    if (changed !== undefined) {
      if (changed.config !== undefined) {
        this.models.set(changed.id, createModel(changed.config))
      } else {
        this.models.delete(changed.id)
      }
    }
  }
}
