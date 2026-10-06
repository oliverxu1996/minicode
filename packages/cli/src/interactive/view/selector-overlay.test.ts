import { describe, expect, test } from "bun:test"
import type { OverlayHandle } from "@minicode/tui"
import { Selector } from "./selector"
import { TuiHarness } from "./testing"

function openSelector(h: TuiHarness, onSelect: (value: string) => void): OverlayHandle {
	const selector = new Selector("Pick one", [
		{ value: "one", label: "one" },
		{ value: "two", label: "two" },
		{ value: "three", label: "three" },
	])
	selector.onSelect = value => {
		onSelect(value)
	}
	return h.tui.showOverlay(selector, { anchor: "center", width: "80%", minWidth: 40, margin: 1 })
}

describe("Selector overlay", () => {
	test("PageUp while the selector is open does not scroll the conversation", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		const beforeScroll = h.scrollTop
		const handle = openSelector(h, () => {})
		expect(handle.isFocused()).toBe(true)
		const whileOpen = h.screen()

		h.feed("\x1b[5~") // PageUp
		h.feed("\x1b[6~") // PageDown
		expect(h.scrollTop).toBe(beforeScroll)
		expect(h.following).toBe(true)
		// Only the overlay's own rendering changes; the conversation rows and
		// fixed chrome are identical.
		expect(h.screen()).toEqual(whileOpen)
		handle.hide()
	})

	test("selector navigation reaches the selector and confirms the choice", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		let selected: string | undefined
		openSelector(h, value => {
			selected = value
		})

		const beforeScroll = h.scrollTop
		h.feed("\x1b[B") // down -> "two"
		h.feed("\r") // confirm
		expect(selected).toBe("two")
		// Navigation did not scroll the conversation.
		expect(h.scrollTop).toBe(beforeScroll)
	})

	test("after the selector closes, conversation scrolling works again", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		const handle = openSelector(h, () => {})
		h.feed("\x1b[5~")
		const whileOpen = h.scrollTop
		handle.hide()
		h.feed("\x1b[5~")
		expect(h.scrollTop).toBeLessThan(whileOpen)
	})
})
