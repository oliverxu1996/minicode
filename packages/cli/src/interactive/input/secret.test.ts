import { describe, expect, test } from "bun:test"
import { TuiHarness } from "../view/testing"

/**
 * Secret input masking, exercised through the real fullscreen renderer: the
 * composer must never paint a credential, while still accepting and submitting
 * the exact value.
 */
describe("Editor secret input", () => {
  test("masked input renders asterisks and never the typed value", () => {
    const h = new TuiHarness({ width: 60, height: 24 }).start()
    const secret = "sk-SUPER-SECRET-42"
    h.editor.setMasked(true)
    h.feed(secret)
    const rows = h.screen()
    expect(rows.join("\n")).not.toContain("SUPER")
    expect(rows.join("\n")).not.toContain("sk-")
    // A masked run of the same length is visible instead.
    expect(rows.some(line => line.includes("*".repeat(secret.length)))).toBe(true)
  })

  test("the value is preserved and submitted unmasked", () => {
    const h = new TuiHarness({ width: 60, height: 24 }).start()
    const secret = "sk-SUPER-SECRET-42"
    h.editor.setMasked(true)
    h.feed(secret)
    expect(h.editor.getText()).toBe(secret)
    h.feed("\r")
    expect(h.submitted).toEqual([secret])
    // Submitting clears the composer.
    expect(h.editor.getText()).toBe("")
  })

  test("unmasking restores normal rendering", () => {
    const h = new TuiHarness({ width: 60, height: 24 }).start()
    h.editor.setMasked(true)
    h.feed("visible-again")
    h.editor.setMasked(false)
    expect(h.screen().join("\n")).toContain("visible-again")
  })
})
