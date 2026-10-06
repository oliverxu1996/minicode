import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import cliManifest from "../package.json" with { type: "json" }
import { MINICODE_VERSION } from "./version"
import { helpText, runCli, type CliIO } from "./main"

interface Captured {
  readonly io: CliIO
  readonly stdout: () => string
  readonly stderr: () => string
}

function capture(stdinIsTTY: boolean): Captured {
  let out = ""
  let err = ""
  return {
    io: {
      stdout: text => { out += text },
      stderr: text => { err += text },
      stdinIsTTY,
    },
    stdout: () => out,
    stderr: () => err,
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "minicode-cli-test-"))
}

describe("CLI help", () => {
  test("describes the product command, not a development path", () => {
    const help = helpText()
    expect(help).toContain("usage: minicode [options] [workspace]")
    expect(help).not.toContain("bun packages/")
    expect(help).not.toContain("main.ts")
  })

  test("documents every supported option", () => {
    const help = helpText()
    for (const option of ["-p, --print", "--mode json", "-c, --continue", "--resume", "--cwd", "-v, --version", "-h, --help"]) {
      expect(help).toContain(option)
    }
  })

  test("--help and -h print it and exit 0, even without a terminal", async () => {
    for (const flag of ["--help", "-h"]) {
      const c = capture(false)
      expect(await runCli([flag], c.io)).toBe(0)
      expect(c.stdout()).toContain("usage: minicode")
      expect(c.stderr()).toBe("")
    }
  })
})

describe("CLI version", () => {
  test("--version and -v print the product version and exit 0", async () => {
    for (const flag of ["--version", "-v"]) {
      const c = capture(false)
      expect(await runCli([flag], c.io)).toBe(0)
      expect(c.stdout()).toBe(MINICODE_VERSION + "\n")
      expect(c.stderr()).toBe("")
    }
  })

  test("agrees with the published CLI package manifest", () => {
    expect(MINICODE_VERSION).toBe(cliManifest.version)
  })

  test("agrees with the newest changelog release", () => {
    const changelog = readFileSync(join(import.meta.dir, "../../../CHANGELOG.md"), "utf-8")
    const firstRelease = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)
    expect(firstRelease).not.toBeNull()
    expect(firstRelease![1]).toBe(MINICODE_VERSION)
  })
})

describe("CLI interactive guard", () => {
  test("refuses to start the TUI without a terminal instead of hanging", async () => {
    const c = capture(false)
    const code = await runCli([], c.io)
    expect(code).toBe(1)
    // Nothing may be written to stdout: a refused start must not paint the UI.
    expect(c.stdout()).toBe("")
    expect(c.stderr()).toContain("stdin is not a terminal")
    expect(c.stderr()).toContain("minicode -p")
  })

  test("the guard applies to a workspace argument too", async () => {
    const dir = tempDir()
    try {
      const c = capture(false)
      expect(await runCli([dir], c.io)).toBe(1)
      expect(c.stderr()).toContain("stdin is not a terminal")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("print mode is not blocked by the guard", async () => {
    const dir = tempDir()
    const previous = process.env.MINICODE_CONFIG_DIR
    process.env.MINICODE_CONFIG_DIR = dir
    try {
      const c = capture(false)
      // No model is configured in the isolated config dir, so this fails on
      // configuration — the point is that it gets that far.
      const outcome = await runCli(["-p", "hello", dir], c.io).catch((err: unknown) => err as Error)
      expect(String(outcome)).toMatch(/No active model configured/)
      expect(c.stderr()).not.toContain("stdin is not a terminal")
    } finally {
      if (previous === undefined) delete process.env.MINICODE_CONFIG_DIR
      else process.env.MINICODE_CONFIG_DIR = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
