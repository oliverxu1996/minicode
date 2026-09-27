import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandFileReferences } from "./tui/expand"

describe("@file expansion", () => {
  test("expands an existing file reference into a marked block", () => {
    const dir = mkdtempSync(join(tmpdir(), "minicode-expand-"))
    try {
      writeFileSync(join(dir, "notes.md"), "# Notes\nthe payload")
      const expanded = expandFileReferences("review @notes.md please", dir)
      expect(expanded).toContain(`<file path="${join(dir, "notes.md")}">`)
      expect(expanded).toContain("# Notes\nthe payload")
      expect(expanded).toContain("please")
      expect(expanded).not.toContain("@notes.md")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("leaves unresolved references untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "minicode-expand-"))
    try {
      const expanded = expandFileReferences("email me @someone about @missing.txt", dir)
      expect(expanded).toContain("@someone")
      expect(expanded).toContain("@missing.txt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("truncates oversized files", () => {
    const dir = mkdtempSync(join(tmpdir(), "minicode-expand-"))
    try {
      writeFileSync(join(dir, "big.txt"), "x".repeat(300 * 1024))
      const expanded = expandFileReferences("see @big.txt", dir)
      expect(expanded).toContain("file truncated at 200KB")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
