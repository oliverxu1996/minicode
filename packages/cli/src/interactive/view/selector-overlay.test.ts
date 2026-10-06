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

describe("Selector opaque panel surface (overlay)", () => {
	test("conversation inside the panel bounds is occluded and the surface is painted", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		const handle = openSelector(h, () => {})
		const plain = h.screen()
		const bounds = handle.getBounds()!
		const raw = h.rawScreen()
		expect(bounds.width).toBeGreaterThan(0)
		expect(bounds.height).toBeGreaterThan(0)

		for (let row = bounds.row; row < bounds.row + bounds.height; row++) {
			// The emitted row carries the opaque panel background.
			expect(raw[row]).toContain("\x1b[48;5;236m")
			// No conversation text survives inside the panel columns.
			const inside = plain[row]!.slice(bounds.col, bounds.col + bounds.width)
			expect(inside).not.toContain("chat-")
		}
		handle.hide()
	})

	test("conversation outside the panel remains visible", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		const handle = openSelector(h, () => {})
		const plain = h.screen()
		const bounds = handle.getBounds()!
		// A row well above the panel still shows conversation content.
		const above = plain
			.slice(0, bounds.row)
			.find(line => line.includes("chat-"))
		expect(above).toBeDefined()
		// The left margin of a panel row still shows the conversation prefix.
		expect(plain[bounds.row]!.slice(0, Math.max(0, bounds.col))).toContain("chat-")
		handle.hide()
	})

	test("opening and closing leaves the conversation and viewport unchanged", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		const before = h.screen()
		const beforeScroll = h.scrollTop
		const chatCount = h.chat.count

		const handle = openSelector(h, () => {})
		h.screen() // render so the overlay bounds are known
		expect(handle.getBounds()).toBeDefined()
		handle.hide()

		// No conversation message was appended merely by opening the selector.
		expect(h.chat.count).toBe(chatCount)
		// The underlying view is restored exactly and the viewport did not move.
		expect(h.screen()).toEqual(before)
		expect(h.scrollTop).toBe(beforeScroll)
	})

	test("stays centered and opaque at supported sizes", () => {
		for (const [width, height] of [
			[80, 24],
			[60, 20],
			[40, 12],
			[30, 8],
		] as const) {
			const h = new TuiHarness({ width, height, chatLines: 40 }).start()
			const handle = openSelector(h, () => {})
			const plain = h.screen()
			const bounds = handle.getBounds()!
			const raw = h.rawScreen()
			expect(bounds.width).toBeGreaterThan(0)
			expect(bounds.height).toBeGreaterThan(0)
			expect(bounds.col).toBeGreaterThanOrEqual(0)
			expect(bounds.col + bounds.width).toBeLessThanOrEqual(width)
			expect(bounds.row).toBeGreaterThanOrEqual(0)
			expect(bounds.row + bounds.height).toBeLessThanOrEqual(height)

			for (let row = bounds.row; row < bounds.row + bounds.height; row++) {
				expect(raw[row]).toContain("\x1b[48;5;236m")
				const inside = plain[row]!.slice(bounds.col, bounds.col + bounds.width)
				expect(inside).not.toContain("chat-")
			}
			handle.hide()
		}
	})

	test("below the supported minimum it clamps width and never produces invalid dimensions", () => {
		// The panel may overflow the viewport height below the supported minimum
		// (existing sizing behavior); it must not crash or create negative/over-wide
		// geometry, and the surface must still be painted for the visible rows.
		for (const [width, height] of [
			[20, 6],
			[12, 4],
		] as const) {
			const h = new TuiHarness({ width, height, chatLines: 20 }).start()
			const handle = openSelector(h, () => {})
			const plain = h.screen()
			const bounds = handle.getBounds()!
			const raw = h.rawScreen()
			expect(bounds.width).toBeGreaterThan(0)
			expect(bounds.height).toBeGreaterThan(0)
			expect(bounds.col).toBeGreaterThanOrEqual(0)
			expect(bounds.col + bounds.width).toBeLessThanOrEqual(width)

			const firstVisible = Math.max(0, bounds.row)
			const lastVisible = Math.min(height - 1, bounds.row + bounds.height - 1)
			for (let row = firstVisible; row <= lastVisible; row++) {
				expect(raw[row]).toContain("\x1b[48;5;236m")
				const inside = plain[row]!.slice(bounds.col, Math.min(width, bounds.col + bounds.width))
				expect(inside).not.toContain("chat-")
			}
			handle.hide()
		}
	})

	test("fixed footer stays visible below the panel", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		const handle = openSelector(h, () => {})
		const plain = h.screen()
		const bounds = handle.getBounds()!
		expect(bounds.row + bounds.height).toBeLessThanOrEqual(plain.length - 2)
		expect(plain.at(-1)).toBe("FOOTER-2")
		expect(plain.at(-2)).toBe("FOOTER-1")
		handle.hide()
	})
})
