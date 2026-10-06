import { cpSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The user-level MiniCode directory.
 *
 * Defaults to `~/.minicode` and holds every user-scoped artifact directly —
 * `models.json`, `settings.json`, `sessions/`, `prompts/`, `skills/`. It sits
 * beside the project-scoped `<cwd>/.minicode` so user and project state are two
 * clearly separated locations rather than two conventions for the same name.
 *
 * `MINICODE_CONFIG_DIR` overrides the location (tests, alternative installs).
 */
export function configDir(): string {
  const override = process.env.MINICODE_CONFIG_DIR
  if (override !== undefined && override.length > 0) return override
  return join(homedir(), ".minicode")
}

/** The pre-`~/.minicode` user directory: `$XDG_CONFIG_HOME/minicode`. */
function legacyConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(base, "minicode")
}

/**
 * Copies a legacy config tree into the new location, if warranted.
 *
 * Non-destructive: it copies, never moves, so the original is left untouched.
 * A no-op when the target already exists (already migrated or a fresh install)
 * or when there is no legacy directory. Best-effort: a failed copy must not
 * stop the CLI from starting. Exported so the carry-over can be exercised
 * without touching the real home directory.
 */
export function copyLegacyConfigIfNeeded(from: string, to: string): void {
  if (existsSync(to)) return
  if (!existsSync(from)) return
  try {
    cpSync(from, to, { recursive: true })
  } catch {
    // Best-effort: an unwritable target must not break startup.
  }
}

/**
 * One-time, non-destructive carry-over of the legacy `~/.config/minicode`
 * directory into `~/.minicode`.
 *
 * Skips entirely when a `MINICODE_CONFIG_DIR` override is in effect: an
 * explicitly redirected location must not implicitly inherit the real user's
 * legacy config.
 */
export function migrateLegacyConfig(): void {
  const override = process.env.MINICODE_CONFIG_DIR
  if (override !== undefined && override.length > 0) return
  copyLegacyConfigIfNeeded(legacyConfigDir(), configDir())
}
