import { describe, expect, test } from "bun:test"
import { TuiHarness } from "./testing"
import { argumentPlaceholderFor, type ArgumentPlaceholderCommand } from "../input/argument-placeholder"

const COMMANDS: ArgumentPlaceholderCommand[] = [
  { name: "name", argumentPlaceholder: "Name…" },
  { name: "import", argumentPlaceholder: "Path…" },
]

const policy = (state: { lines: string[]; cursorLine: number; cursorCol: number }) =>
  argumentPlaceholderFor(state, COMMANDS)

/** The composer content row (composer = top border, content, bottom border). */
function composerRow(h: TuiHarness): string {
  return h.screen().at(-4)!
}

describe("Editor ghost placeholder", () => {
  test("renders the placeholder after the real input", () => {
    const h = new TuiHarness({ width: 80, height: 24 }).start()
    h.editor.setGhostTextProvider(policy)
    h.editor.setText("/name ")
    const rows = h.screen()
    expect(rows.some(row => row.includes("/name Name…"))).toBe(true)
  })

  test("ghost text is visually muted (faint) in the raw output", () => {
    const h = new TuiHarness({ width: 80, height: 24 }).start()
    h.editor.setGhostTextProvider(policy)
    h.editor.setText("/name ")
    const raw = h.rawScreen().join("")
    expect(raw).toContain("\x1b[2mName…\x1b[22m")
  })

  test("the placeholder is not part of the buffer", () => {
    const h = new TuiHarness({ width: 80, height: 24 }).start()
    h.editor.setGhostTextProvider(policy)
    h.editor.setText("/name ")
    h.screen()
    expect(h.editor.getText()).toBe("/name ")
  })

  test("rendering does not move the logical cursor", () => {
    const h = new TuiHarness({ width: 80, height: 24 }).start()
    h.editor.setGhostTextProvider(policy)
    h.editor.setText("/name ")
    const before = h.editor.getCursor()
    h.screen()
    expect(h.editor.getCursor()).toEqual(before)
  })

  test("typing the argument removes the ghost", () => {
    const h = new TuiHarness({ width: 80, height: 24 }).start()
    h.editor.setGhostTextProvider(policy)
    h.editor.setText("/name ")
    expect(h.screen().some(row => row.includes("Name…"))).toBe(true)
    h.feed("M")
    const rows = h.screen()
    expect(rows.some(row => row.includes("Name…"))).toBe(false)
    expect(h.editor.getText()).toBe("/name M")
  })

  test("a provider returning undefined hides the ghost", () => {
    const h = new TuiHarness({ width: 80, height: 24 }).start()
    h.editor.setGhostTextProvider(() => undefined)
    h.editor.setText("/name ")
    expect(h.screen().some(row => row.includes("Name…"))).toBe(false)
  })

  test("masked mode does not render the ghost", () => {
    const h = new TuiHarness({ width: 80, height: 24 }).start()
    h.editor.setGhostTextProvider(policy)
    h.editor.setText("/name ")
    h.editor.setMasked(true)
    expect(h.screen().some(row => row.includes("Name…"))).toBe(false)
    expect(h.editor.getText()).toBe("/name ")
  })

  test("an open autocomplete list suppresses the ghost", async () => {
    const h = new TuiHarness({ width: 80, height: 24 }).start()
    h.editor.setGhostTextProvider(() => "Name…")
    h.editor.setAutocompleteProvider({
      async getSuggestions(lines, cursorLine, cursorCol) {
        const before = (lines[cursorLine] ?? "").slice(0, cursorCol)
        if (!before.startsWith("/")) return null
        return { items: [{ value: "name", label: "name" }], prefix: before }
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const line = lines[cursorLine] ?? ""
        const start = cursorCol - prefix.length
        const out = [...lines]
        out[cursorLine] = `${line.slice(0, start)}${item.value} ${line.slice(cursorCol)}`
        return { lines: out, cursorLine, cursorCol: start + item.value.length + 1 }
      },
    })
    h.editor.setText("/na")
    h.feed("\t")
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.editor.isShowingAutocomplete()).toBe(true)
    expect(h.screen().some(row => row.includes("Name…"))).toBe(false)
  })

  test("insufficient width omits the ghost without corrupting real text", () => {
    const h = new TuiHarness({ width: 9, height: 24 }).start()
    h.editor.setGhostTextProvider(policy)
    h.editor.setText("/import")
    const row = composerRow(h)
    expect(row).toContain("/import")
    expect(row).not.toContain("Path…")
    expect(h.editor.getText()).toBe("/import")
  })
})
