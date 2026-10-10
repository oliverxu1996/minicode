import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The user-level LoongCode directory.
 *
 * Defaults to `~/.loongcode` and holds every user-scoped artifact directly —
 * `models.json`, `settings.json`, `sessions/`, `prompts/`, `skills/`. It sits
 * beside the project-scoped `<cwd>/.loongcode` so user and project state are two
 * clearly separated locations rather than two conventions for the same name.
 *
 * `LOONGCODE_CONFIG_DIR` overrides the location (tests, alternative installs).
 * It is the one override, and it is authoritative: a directory named by the
 * environment is used as given, never merged with anything else.
 */
export function configDir(): string {
  const override = process.env.LOONGCODE_CONFIG_DIR
  if (override !== undefined && override.length > 0) return override
  return join(homedir(), ".loongcode")
}
