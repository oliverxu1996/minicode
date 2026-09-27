import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** Runtime-tunable settings: global file merged under project
 *  file (project wins), nested objects merge recursively. */
export interface MiniCodeSettings {
  /** Default active model id (ModelManager still owns credentials). */
  model?: string
  autoCompact?: {
    /** Proactive compaction before the input budget is exhausted. Default on. */
    enabled: boolean
    /** Percentage of the 75% input budget that triggers compaction. Default 80. */
    thresholdPct: number
  }
  theme?: "dark" | "light"
}

const DEFAULTS: MiniCodeSettings = {
  autoCompact: { enabled: true, thresholdPct: 80 },
  theme: "dark",
}

export interface LoadedSettings {
  settings: MiniCodeSettings
  /** Merged view for display; sources for diagnostics. */
  globalPath: string
  projectPath: string | null
  projectExists: boolean
}

export function globalSettingsPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(base, "minicode", "settings.json")
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".minicode", "settings.json")
}

/** Reads and validates one settings file; invalid JSON or shape throws
 *  `configuration_error`-style Error (callers surface it). */
function readSettingsFile(path: string, exists: boolean): Partial<MiniCodeSettings> {
  if (!exists) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
  } catch (err) {
    throw new Error(`invalid settings file ${path}: ${err instanceof Error ? err.message : err}`)
  }
  return validateSettings(parsed, path)
}

function validateSettings(input: unknown, path: string): Partial<MiniCodeSettings> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`invalid settings file ${path}: expected an object`)
  }
  const record = input as Record<string, unknown>
  const out: Partial<MiniCodeSettings> = {}
  if (record.model !== undefined) {
    if (typeof record.model !== "string") throw new Error(`invalid settings file ${path}: model must be a string`)
    out.model = record.model
  }
  if (record.theme !== undefined) {
    if (record.theme !== "dark" && record.theme !== "light") {
      throw new Error(`invalid settings file ${path}: theme must be "dark" or "light"`)
    }
    out.theme = record.theme
  }
  if (record.autoCompact !== undefined) {
    if (typeof record.autoCompact !== "object" || record.autoCompact === null) {
      throw new Error(`invalid settings file ${path}: autoCompact must be an object`)
    }
    const ac = record.autoCompact as Record<string, unknown>
    const enabled = ac.enabled === undefined ? true : ac.enabled === true
    const thresholdPct = ac.thresholdPct === undefined ? DEFAULTS.autoCompact!.thresholdPct : ac.thresholdPct
    if (typeof thresholdPct !== "number" || thresholdPct < 10 || thresholdPct > 100) {
      throw new Error(`invalid settings file ${path}: autoCompact.thresholdPct must be 10..100`)
    }
    out.autoCompact = { enabled, thresholdPct }
  }
  return out
}

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(override)) {
    const current = out[key]
    if (
      typeof value === "object" && value !== null && !Array.isArray(value) &&
      typeof current === "object" && current !== null && !Array.isArray(current)
    ) {
      out[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out as unknown as T
}

/** Loads global + project settings with deterministic precedence
 *  (project overrides global, per-key deep merge). */
export function loadSettings(cwd: string): LoadedSettings {
  const globalPath = globalSettingsPath()
  const projectPath = projectSettingsPath(cwd)
  const globalExists = existsSync(globalPath)
  const projectExists = existsSync(projectPath)

  const global = readSettingsFile(globalPath, globalExists)
  const project = readSettingsFile(projectPath, projectExists)

  const merged = deepMerge(deepMerge(DEFAULTS, global), project)
  return { settings: merged, globalPath, projectPath, projectExists }
}

/** Writes a settings file (creates directories). */
export function saveSettings(path: string, settings: MiniCodeSettings): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8")
}
