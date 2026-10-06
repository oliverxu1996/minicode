import { describe, expect, test } from "bun:test"
import { altEnterAsNewline } from "./alt-enter"
import { TuiHarness } from "../view/testing"

describe("Alt+Enter key translation", () => {
	// The three encodings verified in the investigation.
	const ALT_ENTER = [
		["legacy ESC CR", "\x1b\r"],
		["Kitty CSI-u", "\x1b[13;3u"],
		["xterm modifyOtherKeys", "\x1b[27;3;13~"],
	] as const

	for (const [name, bytes] of ALT_ENTER) {
		test(`${name} is rewritten to a newline input`, () => {
			expect(altEnterAsNewline(bytes)).toEqual({ data: "\n" })
		})
	}

	test("Enter (submit) is not rewritten", () => {
		expect(altEnterAsNewline("\r")).toBeUndefined()
	})

	test("plain characters are not rewritten", () => {
		expect(altEnterAsNewline("a")).toBeUndefined()
	})
})

describe("Alt+Enter through the real editor", () => {
	// The application registers its translation at the input-listener boundary;
	// the editor then owns newline vs submit. This exercises the actual path.
	function harness(): TuiHarness {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 0 })
		h.addInputListener(altEnterAsNewline)
		return h.start()
	}

	for (const [name, bytes] of [
		["legacy ESC CR", "\x1b\r"],
		["Kitty CSI-u", "\x1b[13;3u"],
		["xterm modifyOtherKeys", "\x1b[27;3;13~"],
	] as const) {
		test(`${name} inserts a newline and does not submit`, () => {
			const h = harness()
			h.feed("alpha")
			h.feed(bytes)
			expect(h.editor.getText()).toBe("alpha\n")
			expect(h.submitted).toEqual([])
		})
	}

	test("Alt+Enter does not submit an otherwise-empty composer", () => {
		const h = harness()
		h.feed("\x1b\r")
		expect(h.editor.getText()).toBe("\n")
		expect(h.submitted).toEqual([])
	})

	test("Enter submits the complete multiline prompt", () => {
		const h = harness()
		h.feed("line one")
		h.feed("\x1b[13;3u")
		h.feed("line two")
		expect(h.editor.getText()).toBe("line one\nline two")
		h.feed("\r")
		expect(h.submitted).toEqual(["line one\nline two"])
		expect(h.editor.getText()).toBe("")
	})

	test("no queued notice is produced while a run would be active", () => {
		// The old behaviour consumed Alt+Enter and pushed to an application queue;
		// the new behaviour always inserts a newline, regardless of run state.
		const h = harness()
		h.feed("first")
		h.feed("\x1b\r")
		h.feed("second")
		expect(h.editor.getText()).toBe("first\nsecond")
		expect(h.submitted).toEqual([])
	})
})

describe("Editor Ctrl behavior is unchanged", () => {
	test("Ctrl+U clears the line and Enter still submits", () => {
		const h = new TuiHarness({ width: 60, height: 24 }).start()
		h.feed("discard me")
		h.feed("\x15") // ctrl+u deleteToLineStart
		expect(h.editor.getText()).toBe("")
		h.feed("keep")
		h.feed("\r")
		expect(h.submitted).toEqual(["keep"])
	})

	test("Ctrl+A / Ctrl+E move the editor cursor, not the conversation", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		const before = h.scrollTop
		h.feed("abcdef")
		h.feed("\x01") // ctrl+a -> line start
		h.feed("X")
		h.feed("\x05") // ctrl+e -> line end
		h.feed("Y")
		expect(h.editor.getText()).toBe("XabcdefY")
		expect(h.scrollTop).toBe(before)
	})
})
