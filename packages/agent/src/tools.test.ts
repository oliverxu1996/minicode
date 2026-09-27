import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CODING_TOOLS } from "./tools"

const ctx = (cwd: string) => ({ cwd })

function tempWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "minicode-tools-test-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("coding tools (AC2/AC3/AC4)", () => {
  test("read returns numbered lines and paging hints", async () => {
    const { dir, cleanup } = tempWorkspace()
    writeFileSync(join(dir, "sample.txt"), "alpha\nbeta\ngamma\n")
    const result = await CODING_TOOLS.get("read")!.execute({ filePath: "sample.txt" }, ctx(dir))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toContain("1: alpha")
      expect(result.data).toContain("3: gamma")
      expect(result.data).toContain("End of file - total 3 lines")
    }
    cleanup()
  })

  test("read suggests similar filenames on miss", async () => {
    const { dir, cleanup } = tempWorkspace()
    writeFileSync(join(dir, "config.json"), "{}")
    const result = await CODING_TOOLS.get("read")!.execute({ filePath: "confg.json" }, ctx(dir))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("Did you mean")
    cleanup()
  })

  test("read refuses binary files", async () => {
    const { dir, cleanup } = tempWorkspace()
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]))
    const result = await CODING_TOOLS.get("read")!.execute({ filePath: "blob.bin" }, ctx(dir))
    expect(result.ok).toBe(false)
    cleanup()
  })

  test("write creates files; edit replaces exact spans and returns a diff", async () => {
    const { dir, cleanup } = tempWorkspace()
    const write = CODING_TOOLS.get("write")!
    const created = await write.execute({ filePath: "src/new.ts", content: "const a = 1\n" }, ctx(dir))
    expect(created.ok).toBe(true)

    const edit = CODING_TOOLS.get("edit")!
    const edited = await edit.execute({
      filePath: "src/new.ts",
      oldString: "const a = 1",
      newString: "const a = 2",
    }, ctx(dir))
    expect(edited.ok).toBe(true)
    const content = await Bun.file(join(dir, "src/new.ts")).text()
    expect(content).toBe("const a = 2\n")
    if (edited.ok) expect(edited.data).toContain("-const a = 1")

    cleanup()
  })

  test("edit refuses ambiguous matches without replaceAll", async () => {
    const { dir, cleanup } = tempWorkspace()
    writeFileSync(join(dir, "dup.txt"), "same\nsame\n")
    const edit = CODING_TOOLS.get("edit")!
    const refused = await edit.execute({ filePath: "dup.txt", oldString: "same", newString: "different" }, ctx(dir))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toContain("2 occurrences")

    const all = await edit.execute({ filePath: "dup.txt", oldString: "same", newString: "different", replaceAll: true }, ctx(dir))
    expect(all.ok).toBe(true)
    const content = await Bun.file(join(dir, "dup.txt")).text()
    expect(content).toBe("different\ndifferent\n")
    cleanup()
  })

  test("edit with empty oldString creates the file", async () => {
    const { dir, cleanup } = tempWorkspace()
    const result = await CODING_TOOLS.get("edit")!.execute({
      filePath: "created.md",
      oldString: "",
      newString: "# Hello",
    }, ctx(dir))
    expect(result.ok).toBe(true)
    expect(await Bun.file(join(dir, "created.md")).text()).toBe("# Hello")
    cleanup()
  })

  test("bash captures stdout, stderr, and exit codes (AC4)", async () => {
    const { dir, cleanup } = tempWorkspace()
    const result = await CODING_TOOLS.get("bash")!.execute({
      command: "echo out; echo err 1>&2; exit 7",
    }, ctx(dir))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toContain("out")
      expect(result.data).toContain("err")
      expect(result.data).toContain("(exit code: 7)")
    }
    cleanup()
  })

  test("grep searches contents; find matches globs; ls lists", async () => {
    const { dir, cleanup } = tempWorkspace()
    mkdirSync(join(dir, "pkg"), { recursive: true })
    writeFileSync(join(dir, "pkg/a.ts"), "export const needle = 1\n")
    writeFileSync(join(dir, "pkg/b.ts"), "export const other = 2\n")

    const grep = await CODING_TOOLS.get("grep")!.execute({ pattern: "needle", path: "pkg" }, ctx(dir))
    expect(grep.ok).toBe(true)
    if (grep.ok) expect(grep.data).toContain("a.ts")

    const find = await CODING_TOOLS.get("find")!.execute({ pattern: "**/*.ts" }, ctx(dir))
    expect(find.ok).toBe(true)
    if (find.ok) expect(find.data).toContain("pkg/a.ts")

    const ls = await CODING_TOOLS.get("ls")!.execute({}, ctx(dir))
    expect(ls.ok).toBe(true)
    if (ls.ok) expect(ls.data).toBe("pkg/")

    const miss = await CODING_TOOLS.get("grep")!.execute({ pattern: "zzz-not-there" }, ctx(dir))
    expect(miss.ok).toBe(true)
    cleanup()
  })

  test("bash defaults the workdir to the session cwd via executeTool", async () => {
    const { dir, cleanup } = tempWorkspace()
    writeFileSync(join(dir, "marker.txt"), "here")
    const tool = CODING_TOOLS.get("bash")!
    const result = await tool.execute({ command: "ls" }, ctx(dir))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toContain("marker.txt")
    cleanup()
  })
})
