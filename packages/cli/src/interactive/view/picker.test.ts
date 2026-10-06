import { describe, expect, test } from "bun:test"
import { TuiHarness } from "./testing"
import type { SelectorItem } from "./selector"

const ITEMS: SelectorItem[] = [
	{ value: "one", label: "model one" },
	{ value: "two", label: "model two", description: "active" },
	{ value: "three", label: "model three" },
]

/** Rows the picker occupies, from its title row through its hint row. */
function pickerSpan(rows: string[], title: string): { title: number; hint: number } {
	const titleRow = rows.findIndex(line => line.includes(title))
	const hintRow = rows.findIndex(line => line.includes("enter select"))
	return { title: titleRow, hint: hintRow }
}

describe("Bottom-attached picker layout", () => {
	test("picker is closed by default and consumes no viewport", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		const closedViewport = h.viewportHeight
		const rows = h.screen()
		expect(rows.some(line => line.includes("Select model"))).toBe(false)
		expect(closedViewport).toBe(24 - 3 - 2) // composer + two footers
	})

	test("opening attaches the picker directly above the composer", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		h.openPicker("Select model", ITEMS)
		const rows = h.screen()
		const { title, hint } = pickerSpan(rows, "Select model")

		// Picker starts below the conversation and its rows are contiguous.
		expect(title).toBeGreaterThan(0)
		expect(hint).toBe(title + 1 + ITEMS.length)
		expect(title).toBe(h.viewportHeight)

		// Immediately below the hint is the composer (top border, content, bottom border).
		expect(rows[hint + 1]).toMatch(/^─+$/)
		expect(rows[hint + 3]).toMatch(/^─+$/)
		// And the footer remains the last two rows.
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
	})

	test("opening consumes viewport height equal to the picker height", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		const before = h.viewportHeight
		h.openPicker("Select model", ITEMS)
		const rows = h.screen()
		const pickerHeight = 1 + ITEMS.length + 1
		expect(h.viewportHeight).toBe(before - pickerHeight)
		// The conversation above the picker is still conversation, not the picker.
		expect(rows.slice(0, h.viewportHeight).every(l => l.startsWith("header-") || l.startsWith("chat-"))).toBe(true)
	})

	test("picker is not centered over conversation: it sits at the bottom", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		h.openPicker("Select model", ITEMS)
		const rows = h.screen()
		const { title } = pickerSpan(rows, "Select model")
		// Its title row is in the lower half and the conversation continues above.
		expect(title).toBeGreaterThan(Math.floor(24 / 2))
		expect(rows[title - 1]).toMatch(/^(header-|chat-)/)
	})

	test("picker never overlaps the composer or footer", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		h.openPicker("Select model", ITEMS)
		const rows = h.screen()
		const { title, hint } = pickerSpan(rows, "Select model")
		const pickerSet = new Set(rows.slice(title, hint + 1))
		// The composer/footer rows are disjoint from the picker rows.
		expect(pickerSet.has("FOOTER-1")).toBe(false)
		expect(pickerSet.has("FOOTER-2")).toBe(false)
		expect(rows[hint + 1]).not.toContain("Select model")
	})

	test("conversation is not visible inside the picker bounds and the surface is opaque", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		h.openPicker("Select model", ITEMS)
		const plain = h.screen()
		const raw = h.rawScreen()
		const { title, hint } = pickerSpan(plain, "Select model")
		for (let row = title; row <= hint; row++) {
			expect(plain[row]).not.toContain("chat-")
			expect(raw[row]).toContain("\x1b[48;5;236m")
		}
	})

	test("closing restores the conversation viewport exactly", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		const before = h.screen()
		const beforeViewport = h.viewportHeight
		const chatCount = h.chat.count

		const selector = h.openPicker("Select model", ITEMS)
		selector.handleInput("\x1b") // cancel
		// The harness restores focus and clears the slot on cancel.
		const after = h.screen()

		expect(h.viewportHeight).toBe(beforeViewport)
		expect(after).toEqual(before)
		expect(h.chat.count).toBe(chatCount) // no fake message appended
		expect(after.some(l => l.includes("Select model"))).toBe(false)
	})

	test("no duplicate picker remains after reopening and closing", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		h.openPicker("First", ITEMS)
		h.openPicker("Second", ITEMS)
		const open = h.screen()
		expect(open.filter(l => l.includes("Second")).length).toBeGreaterThan(0)
		expect(open.some(l => l.includes("First"))).toBe(false)
		h.picker.setSelector(null)
		expect(h.screen().some(l => l.includes("Second"))).toBe(false)
	})
})

describe("Bottom-attached picker interaction", () => {
	test("Up/Down navigate and Enter selects the highlighted item", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		let result: string | null | undefined
		h.openPicker("Select model", ITEMS, value => {
			result = value
		})
		h.feed("\x1b[B") // down -> two
		h.feed("\r") // confirm
		expect(result).toBe("two")
	})

	test("Escape cancels without selecting", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		let result: string | null | undefined = "unset"
		h.openPicker("Select model", ITEMS, value => {
			result = value
		})
		h.feed("\x1b")
		expect(result).toBeNull()
	})

	test("picker owns navigation: Up/Down do not scroll the conversation", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		h.openPicker("Select model", ITEMS)
		const beforeScroll = h.scrollTop
		h.feed("\x1b[B")
		h.feed("\x1b[B")
		h.feed("\x1b[A")
		expect(h.scrollTop).toBe(beforeScroll)
	})

	test("composer stays usable after the picker closes", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		const selector = h.openPicker("Select model", ITEMS)
		selector.handleInput("\x1b")
		h.feed("hello")
		h.feed("\r")
		expect(h.submitted).toEqual(["hello"])
	})
})

describe("Bottom-attached picker at terminal sizes", () => {
	test("supported sizes keep the picker above the composer with the footer visible", () => {
		for (const [width, height] of [
			[80, 24],
			[60, 20],
			[40, 12],
			[30, 8],
		] as const) {
			const h = new TuiHarness({ width, height, chatLines: 40 }).start()
			h.openPicker("Select model", ITEMS)
			const rows = h.screen()
			const { title, hint } = pickerSpan(rows, "Select model")
			expect(rows).toHaveLength(height)
			expect(title).toBeGreaterThanOrEqual(0)
			expect(hint).toBeGreaterThanOrEqual(title)
			expect(hint).toBeLessThan(height)
			// Composer directly below the picker, footer the final rows.
			expect(rows[hint + 1]).toMatch(/^─+$/)
			expect(rows.at(-1)).toBe("FOOTER-2")
			expect(rows.at(-2)).toBe("FOOTER-1")
			expect(h.viewportHeight).toBeGreaterThanOrEqual(0)
		}
	})

	test("below the supported minimum it degrades without crashing or negative sizes", () => {
		for (const [width, height] of [
			[20, 6],
			[12, 4],
		] as const) {
			const h = new TuiHarness({ width, height, chatLines: 40 }).start()
			h.openPicker("Select model", ITEMS)
			const rows = h.screen()
			expect(rows).toHaveLength(height)
			expect(h.viewportHeight).toBeGreaterThanOrEqual(0)
			expect(Number.isFinite(h.scrollTop)).toBe(true)
		}
	})

	test("a long list is windowed so it cannot push the composer off-screen", () => {
		const many: SelectorItem[] = Array.from({ length: 60 }, (_, i) => ({ value: String(i), label: `item ${i}` }))
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		h.openPicker("Pick", many)
		const rows = h.screen()
		const { hint } = pickerSpan(rows, "Pick")
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
		expect(rows[hint + 1]).toMatch(/^─+$/)
		// The selected (first) item is visible even though the list is long.
		const selectedRow = rows.findIndex(l => l.includes("❯"))
		expect(selectedRow).toBeGreaterThanOrEqual(hint - 1 - 15)
	})

	test("selection stays visible while navigating a windowed long list", () => {
		const many: SelectorItem[] = Array.from({ length: 60 }, (_, i) => ({ value: String(i), label: `item ${i}` }))
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 40 }).start()
		h.openPicker("Pick", many)
		for (let i = 0; i < 40; i++) h.feed("\x1b[B")
		const rows = h.screen()
		const selected = rows.find(l => l.includes("❯"))
		expect(selected).toContain("item 40")
		expect(rows.at(-1)).toBe("FOOTER-2")
	})
})
