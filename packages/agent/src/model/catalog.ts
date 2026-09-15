/**
 * A model provider and the models it makes available.
 */
export interface Provider {
  /** Stable provider identifier. */
  readonly id: string

  /** Human-readable provider name. */
  readonly name: string

  /** API endpoint used to access the provider. */
  readonly api: string

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
  }

  /** Token pricing metadata. */
  readonly cost?: {
    /** Input token price. */
    readonly input: number

    /** Output token price. */
    readonly output: number

    /** Cached input token price. */
    readonly cache_read?: number
  }
}

/**
 * Provides read-only access to the providers and models in the catalog.
 *
 * The catalog exposes no operations to register, replace, or remove providers.
 */
export class ModelCatalog {
  constructor(
    private readonly providers: readonly Provider[],
  ) {}

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
}
