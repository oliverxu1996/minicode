import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Remote source of the catalog. */
const MODELS_DEV_URL = "https://models.dev/api.json"

/** How long a cached catalog is considered fresh. */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * A model provider and the models it makes available.
 */
export interface Provider {
  /** Stable provider identifier. */
  readonly id: string

  /** Human-readable provider name. */
  readonly name: string

  /** API endpoint used to access the provider. Absent for providers whose
   *  endpoint is implied by their integration package. */
  readonly api?: string

  /** NPM package used to integrate with the provider. */
  readonly npm: string

  /** Environment variables used to configure provider credentials. */
  readonly env: readonly string[]

  /** Provider documentation URL. */
  readonly doc?: string

  /** Models available from this provider. */
  readonly models: Readonly<Record<string, Model>>
}

/**
 * Metadata describing a model in the catalog.
 */
export interface Model {
  /** Stable model identifier used by the provider API. */
  readonly id: string

  /** Human-readable model name. */
  readonly name: string

  /** Human-readable description of the model. */
  readonly description?: string

  /** Model family or series. */
  readonly family?: string

  /** Whether the model accepts file attachments. */
  readonly attachment?: boolean

  /** Whether the model supports reasoning. */
  readonly reasoning?: boolean

  /** Supported reasoning configuration options. */
  readonly reasoning_options?: readonly unknown[]

  /** Whether the model supports tool calling. */
  readonly tool_call?: boolean

  /** Whether the model supports structured output. */
  readonly structured_output?: boolean

  /** Whether the model supports temperature configuration. */
  readonly temperature?: boolean

  /** Approximate knowledge cutoff date. */
  readonly knowledge?: string

  /** Model release date. */
  readonly release_date?: string

  /** Date when the model metadata was last updated. */
  readonly last_updated?: string

  /** Supported input and output modalities. */
  readonly modalities?: {
    readonly input: readonly string[]
    readonly output: readonly string[]
  }

  /** Whether the model weights are publicly available. */
  readonly open_weights?: boolean

  /** Model context-window and maximum-output limits. */
  readonly limit?: {
    /** Maximum context window in tokens. */
    readonly context: number

    /** Maximum output tokens per request. */
    readonly output: number

    /** Present when the provider caps input separately from the context window. */
    readonly input?: number
  }

  /** Token pricing metadata. Absent when the source publishes no pricing for
   *  this model. Further source fields (such as `context_over_200k` and
   *  `tiers`) are preserved at runtime but are not modelled here. */
  readonly cost?: {
    /** Input token price. */
    readonly input: number

    /** Output token price. */
    readonly output: number

    /** Cached input token price. */
    readonly cache_read?: number

    /** Cache write token price. */
    readonly cache_write?: number
  }
}

/**
 * Provides read-only access to the providers and models in the catalog.
 *
 * The catalog is normally obtained from {@link ModelCatalog.load}, which
 * serves a locally cached copy of the models.dev catalog and refreshes it in
 * the background. Once loaded it performs no I/O: every lookup is synchronous
 * and either returns a value or `undefined`.
 */
export class ModelCatalog {
  private providers: readonly Provider[]
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshing = false

  constructor(providers: readonly Provider[]) {
    this.providers = providers
  }

  /**
   * Loads the catalog, preferring the local cache.
   *
   * Resolves as soon as a usable catalog is available. A valid cache is used
   * without contacting the remote source, so startup never waits on the
   * network when a cache exists — including a stale one, which is served
   * immediately while a refresh runs in the background. Only a first run with
   * no usable cache waits on the remote source.
   */
  static async load(): Promise<ModelCatalog> {
    const cached = await ModelCatalog.readCache()

    if (cached) {
      const catalog = new ModelCatalog(cached.providers)
      catalog.startRefreshTimer()
      if (cached.stale) void catalog.refresh()
      return catalog
    }

    const payload = await ModelCatalog.fetchPayload()
    // Validate before persisting: an invalid payload never reaches the cache.
    const providers = ModelCatalog.parseProviders(payload)
    await ModelCatalog.writeCache(payload)
    const catalog = new ModelCatalog(providers)
    catalog.startRefreshTimer()
    return catalog
  }

  /**
   * Stops the background refresh timer. The catalog remains usable; only
   * automatic refresh ends. Safe to call more than once.
   */
  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getProvider(providerId: string): Provider | undefined {
    return this.providers.find(provider => provider.id === providerId)
  }

  /** Undefined when either the provider or the model is unknown to the catalog. */
  getModel(providerId: string, modelId: string): Model | undefined {
    const provider = this.getProvider(providerId)

    return provider && Object.hasOwn(provider.models, modelId)
      ? provider.models[modelId]
      : undefined
  }

  listProviders(): readonly Provider[] {
    return this.providers
  }

  /** Empty when the provider is unknown, rather than an error. */
  listModels(providerId: string): readonly Model[] {
    const provider = this.getProvider(providerId)
    return provider ? Object.values(provider.models) : []
  }

  /**
   * Refreshes from the remote source and swaps the result in only if the whole
   * payload validates and is persisted. Never throws — a failed refresh leaves
   * the current catalog in place — and never runs concurrently with itself.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true

    try {
      const payload = await ModelCatalog.fetchPayload()
      const providers = ModelCatalog.parseProviders(payload)
      await ModelCatalog.writeCache(payload)
      this.providers = providers
    } catch {
      // Keep the last valid catalog.
    } finally {
      this.refreshing = false
    }
  }

  private startRefreshTimer(): void {
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS)
    // A background refresh must not hold a short-lived process open.
    this.timer.unref()
  }

  /** Location of the local cache, under the OS user cache directory. */
  private static cachePath(): string {
    const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")
    return join(base, "minicode", "models.json")
  }

  /**
   * Reads and validates the cache. Returns `null` for a missing, unreadable,
   * or invalid cache: an unusable cache is treated as absent rather than as an
   * error, and is left on disk.
   */
  private static async readCache(): Promise<{ providers: Provider[]; stale: boolean } | null> {
    const path = ModelCatalog.cachePath()

    try {
      const [raw, info] = await Promise.all([readFile(path, "utf-8"), stat(path)])
      const providers = ModelCatalog.parseProviders(JSON.parse(raw))
      return { providers, stale: Date.now() - info.mtimeMs > REFRESH_INTERVAL_MS }
    } catch {
      return null
    }
  }

  /**
   * Persists a payload that has already validated. The source payload is
   * stored as published rather than the normalized catalog, so cached data
   * round-trips through exactly the same parser as the remote source.
   */
  private static async writeCache(payload: unknown): Promise<void> {
    const path = ModelCatalog.cachePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(payload), "utf-8")
  }

  /** Fetches the raw remote payload. Validation is the caller's step. */
  private static async fetchPayload(): Promise<unknown> {
    const response = await fetch(MODELS_DEV_URL)
    if (!response.ok) {
      throw new Error(`models.dev: unexpected response status ${response.status}`)
    }
    return await response.json()
  }

  /**
   * Validates and normalizes a payload. The source is an object keyed by
   * provider id.
   *
   * Records are validated individually: a provider or model that does not
   * match the contract is dropped rather than rejecting the whole payload, so
   * one malformed entry upstream cannot block every other model from reaching
   * MiniCode — the point of loading this catalog rather than shipping it.
   * Two guarantees still hold absolutely: every record present in the result
   * is valid, and a payload that yields nothing usable is rejected outright,
   * so a bad refresh can never replace a good catalog with an empty one.
   */
  private static parseProviders(input: unknown): Provider[] {
    if (!ModelCatalog.isRecord(input)) {
      throw new Error("models.dev: expected a top-level object keyed by provider id")
    }

    const providers: Provider[] = []
    for (const [providerKey, rawProvider] of Object.entries(input)) {
      try {
        providers.push(ModelCatalog.parseProvider(providerKey, rawProvider))
      } catch {
        // Drop the provider; the rest of the catalog is unaffected.
      }
    }

    if (providers.length === 0) {
      throw new Error("models.dev: payload contains no usable providers")
    }

    return providers
  }

  private static parseProvider(key: string, input: unknown): Provider {
    if (!ModelCatalog.isRecord(input)) {
      throw new Error(`models.dev: provider "${key}" is not an object`)
    }
    if (!ModelCatalog.isRecord(input.models)) {
      throw new Error(`models.dev: provider "${key}" has no models object`)
    }

    const models: Record<string, Model> = {}
    for (const [modelKey, rawModel] of Object.entries(input.models)) {
      let model: Model
      try {
        model = ModelCatalog.parseModel(key, modelKey, rawModel)
      } catch {
        // Drop the model; the rest of the provider is unaffected.
        continue
      }
      // Key by the model's own id so a lookup by id always resolves, even if
      // the source's container key were ever to diverge from it.
      models[model.id] = model
    }

    // A provider with no usable models is not usable itself. This is also what
    // prevents a payload whose model shape has drifted from validating down to
    // a catalog of providers with nothing in them.
    if (Object.keys(models).length === 0) {
      throw new Error(`models.dev: provider "${key}" has no usable models`)
    }

    return {
      id: ModelCatalog.requireString(input.id, `provider "${key}".id`),
      name: ModelCatalog.requireString(input.name, `provider "${key}".name`),
      npm: ModelCatalog.requireString(input.npm, `provider "${key}".npm`),
      env: ModelCatalog.requireStringArray(input.env, `provider "${key}".env`),
      api: ModelCatalog.optionalString(input.api, `provider "${key}".api`),
      doc: ModelCatalog.optionalString(input.doc, `provider "${key}".doc`),
      models,
    }
  }

  private static parseModel(providerKey: string, modelKey: string, input: unknown): Model {
    if (!ModelCatalog.isRecord(input)) {
      throw new Error(`models.dev: model "${providerKey}/${modelKey}" is not an object`)
    }

    const where = `model "${providerKey}/${modelKey}"`
    // Only the fields the catalog treats as required are checked. Optional
    // metadata is passed through exactly as published — never defaulted, and
    // any source fields beyond the interface are preserved.
    return {
      ...input,
      id: ModelCatalog.requireString(input.id, `${where}.id`),
      name: ModelCatalog.requireString(input.name, `${where}.name`),
    } as Model
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

  private static requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`models.dev: ${label} must be a non-empty string`)
    }
    return value
  }

  private static optionalString(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined
    return ModelCatalog.requireString(value, label)
  }

  private static requireStringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || !value.every(entry => typeof entry === "string")) {
      throw new Error(`models.dev: ${label} must be an array of strings`)
    }
    return value
  }
}
