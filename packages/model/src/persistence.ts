import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { validateModelConfig } from "./config"
import { configurationError } from "./errors"
import type { ModelConfig } from "./types"

/**
 * On-disk shape of the model configuration. Versioned so future formats can
 * be migrated instead of misread.
 */
interface PersistedState {
  readonly version: 1
  readonly models: readonly ModelConfig[]
  readonly activeModelId: string | null
}

const EMPTY_STATE: PersistedState = { version: 1, models: [], activeModelId: null }

/** Location of the configuration file: `~/.minicode/models.json`, overridable
 *  with `MINICODE_CONFIG_DIR` so tests and alternative installs can redirect
 *  it — the same location the rest of the runtime uses. */
function configPath(): string {
  const base = process.env.MINICODE_CONFIG_DIR ?? join(homedir(), ".minicode")
  return join(base, "models.json")
}

/**
 * Reads and fully validates the persisted state.
 *
 * A missing file yields the empty state. Anything else that is not a valid
 * state — malformed JSON, a wrong version, an invalid entry — throws a
 * `configuration_error`: the file is user-authored data and is never
 * silently replaced or repaired.
 */
export function loadState(): PersistedState {
  const path = configPath()
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch (error) {
    if (isMissingFileError(error)) return EMPTY_STATE
    throw configurationError(
      `cannot read model configuration file ${path}: ${errorMessage(error)}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw configurationError(
      `model configuration file ${path} contains malformed JSON`,
    )
  }

  return parseState(parsed, path)
}

/**
 * Persists the whole state atomically: the payload is written to a temporary
 * file in the same directory and renamed over the target, so readers observe
 * either the previous or the new state, never a partial write.
 */
export function saveState(models: readonly ModelConfig[], activeModelId: string | null): void {
  const path = configPath()
  const state: PersistedState = { version: 1, models, activeModelId }
  const payload = JSON.stringify(state, null, 2)
  const temporary = `${path}.tmp`

  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, payload, "utf-8")
    renameSync(temporary, path)
  } catch (error) {
    throw configurationError(
      `cannot persist model configuration to ${path}: ${errorMessage(error)}`,
    )
  }
}

function parseState(input: unknown, path: string): PersistedState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw configurationError(`model configuration file ${path} must contain an object`)
  }

  const record = input as Record<string, unknown>

  if (record.version !== 1) {
    throw configurationError(
      `model configuration file ${path} has unsupported version ${JSON.stringify(record.version)}`,
    )
  }

  if (!Array.isArray(record.models)) {
    throw configurationError(`model configuration file ${path} must contain a models array`)
  }

  const models: ModelConfig[] = []
  const ids = new Set<string>()
  for (const entry of record.models) {
    const model = validateModelConfig(entry, `model configuration file ${path} entry`)
    if (ids.has(model.id)) {
      throw configurationError(
        `model configuration file ${path} contains duplicate model id "${model.id}"`,
      )
    }
    ids.add(model.id)
    models.push(model)
  }

  let activeModelId: string | null = null
  if (record.activeModelId !== null && record.activeModelId !== undefined) {
    if (typeof record.activeModelId !== "string" || !ids.has(record.activeModelId)) {
      throw configurationError(
        `model configuration file ${path} has an activeModelId that does not reference a configured model`,
      )
    }
    activeModelId = record.activeModelId
  }

  return { version: 1, models, activeModelId }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
