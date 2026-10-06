/**
 * Shared fixtures for the loop tests: a temp workspace and a runtime root over
 * a scripted model. Identical setup was duplicated across the split loop test
 * files, so it lives here rather than in each.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MiniCode } from "../../src/minicode"
import type { FakeModel } from "./testing"

export function tempWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "minicode-agent-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A runtime root over `model`, with sessions in a temp directory. */
export function agentFor(
  model: FakeModel,
): { agent: MiniCode; model: FakeModel; dir: string; cleanup: () => void } {
  const { dir, cleanup } = tempWorkspace()
  const agent = new MiniCode({ sessionsDir: join(dir, "sessions"), model })
  return { agent, model, dir, cleanup }
}
