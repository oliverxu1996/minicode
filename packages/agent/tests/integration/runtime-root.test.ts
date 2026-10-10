/**
 * The LoongCode runtime root: model resolution and the top-level `run()` door.
 * These exercise the composed root rather than a single concept.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LoongCode } from "../../src/loongcode"

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loongcode-runtime-root-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("Model resolution (V2)", () => {
  test("LoongCode without a configured model reports the missing dependency", async () => {
    const { dir, cleanup } = tempDir()
    const previousConfigDir = process.env.LOONGCODE_CONFIG_DIR
    process.env.LOONGCODE_CONFIG_DIR = join(dir, "config")
    try {
      const agent = new LoongCode()
      const session = agent.createSession(join(dir, "ws"))
      await expect(agent.run(session, "no model")).rejects.toThrow(/No active model/)
    } finally {
      if (previousConfigDir === undefined) delete process.env.LOONGCODE_CONFIG_DIR
      else process.env.LOONGCODE_CONFIG_DIR = previousConfigDir
    }
    cleanup()
  })
})
