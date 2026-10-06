import { describe, expect, test } from "bun:test"
import { TuiHarness } from "./testing"

/** Scrollbar glyphs are painted over the last column of the scroll region. */
function clean(line: string): string {
	return line.replace(/[│┃]\s*$/, "").trimEnd()
}

function screen(h: TuiHarness): string[] {
	return h.screen().map(clean)
}

/** Editor furniture = top border, content, bottom border (empty composer: 3 rows). */
const EDITOR_ROWS = 3

describe("Layout: regions", () => {
	test("empty conversation keeps the composer and both footer rows at the bottom", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 0 }).start()
		const rows = screen(h)
		expect(rows).toHaveLength(24)
		// Header is the first scroll content.
		expect(rows[0]).toBe("header-0")
		// Footer is the last two rows; composer immediately above it.
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
		expect(rows.at(-3)).toMatch(/^─+$/) // composer bottom border
		expect(rows.at(-4 - 1)).toMatch(/^─+$/) // composer top border
	})

	test("short conversation leaves the composer/footer pinned and fills the viewport", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 4 }).start()
		const rows = screen(h)
		expect(rows[0]).toBe("header-0")
		expect(rows[2]).toBe("chat-0")
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
		expect(h.viewportHeight).toBe(24 - EDITOR_ROWS - 2)
	})

	test("overflowing conversation shows the tail and follows the bottom", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		const rows = screen(h)
		expect(h.following).toBe(true)
		expect(h.scrollTop).toBeGreaterThan(0)
		// Last conversation row before the composer is the newest chat line.
		const lastChat = rows.findLast(line => line.startsWith("chat-"))
		expect(lastChat).toBe("chat-59")
		expect(rows.at(-1)).toBe("FOOTER-2")
	})

	test("the composer stays fixed while the conversation scrolls", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		const before = screen(h)
		h.feed("\x1b[5~")
		h.feed("\x1b[5~")
		const after = screen(h)
		// The five bottom rows (composer + footer) are byte-identical.
		expect(after.slice(-5)).toEqual(before.slice(-5))
		// The conversation actually moved.
		expect(after[0]).not.toBe(before[0])
	})

	test("the header scrolls with the conversation rather than staying pinned", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		const atBottom = screen(h)
		expect(atBottom.some(line => line.startsWith("header-"))).toBe(false)
		h.feed("\x1b[1~") // Home
		const atTop = screen(h)
		expect(atTop[0]).toBe("header-0")
		expect(atTop[1]).toBe("header-1")
	})

	test("status/spinner stays outside the conversation viewport, above the composer", () => {
		const h = new TuiHarness({ width: 60, height: 24, chatLines: 60, statusRows: 2 }).start()
		const rows = screen(h)
		// Bottom chrome order: status, composer (border/content/border), footer, footer.
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
		expect(rows.at(-3)).toMatch(/^─+$/) // composer bottom border
		expect(rows.slice(-7, -5)).toEqual(["STATUS-0", "STATUS-1"])
		// Scrolling the conversation does not move the status.
		const statusRows = rows.slice(-7, -5)
		h.feed("\x1b[5~")
		expect(screen(h).slice(-7, -5)).toEqual(statusRows)
	})
})

describe("Layout: multiline composer", () => {
	test("multiline input grows upward and shrinks the conversation viewport", () => {
		const single = new TuiHarness({ width: 60, height: 24, chatLines: 60 }).start()
		const singleViewport = single.viewportHeight

		const multi = new TuiHarness({
			width: 60,
			height: 24,
			chatLines: 60,
			editorText: "a\nb\nc\nd\ne\nf",
		}).start()

		// Five extra content rows move the fixed furniture up by five.
		expect(multi.viewportHeight).toBe(singleViewport - 5)
		const rows = screen(multi)
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
		// The composer content is present above the bottom border.
		expect(rows).toContain("a")
		expect(rows).toContain("f")
	})

	test("the composer height is capped using the editor policy", () => {
		const short = new TuiHarness({ width: 60, height: 24, editorText: "a\nb" }).start()
		const long = new TuiHarness({
			width: 60,
			height: 24,
			editorText: Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n"),
		}).start()
		// max(5, floor(0.30 * 24)) = 7 content rows.
		expect(short.viewportHeight - long.viewportHeight).toBe(5)
		expect(long.viewportHeight).toBeGreaterThan(0)
	})
})

describe("Layout: terminal size policy", () => {
	test("8 rows with a status present keeps every region and >=1 conversation row", () => {
		const h = new TuiHarness({ width: 80, height: 8, chatLines: 40, statusRows: 2 }).start()
		const rows = screen(h)
		expect(rows).toHaveLength(8)
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
		expect(rows.some(line => line.startsWith("STATUS-"))).toBe(true)
		expect(rows.some(line => line.startsWith("chat-"))).toBe(true)
		expect(h.viewportHeight).toBeGreaterThanOrEqual(1)
	})

	test("5-7 rows degrade without crashing and keep the composer usable", () => {
		for (const height of [5, 6, 7]) {
			const h = new TuiHarness({ width: 80, height, chatLines: 40 }).start()
			const rows = screen(h)
			expect(rows).toHaveLength(height)
			// The composer borders survive.
			expect(rows.some(line => /^─+$/.test(line))).toBe(true)
			expect(h.viewportHeight).toBeGreaterThanOrEqual(0)
		}
	})

	test("below the minimum rows the renderer does not crash or produce invalid sizes", () => {
		for (const height of [1, 2, 3, 4]) {
			const h = new TuiHarness({ width: 80, height, chatLines: 40 }).start()
			const rows = screen(h)
			expect(rows).toHaveLength(height)
			expect(h.viewportHeight).toBeGreaterThanOrEqual(0)
			expect(Number.isFinite(h.scrollTop)).toBe(true)
		}
	})

	test("a single-column terminal renders without crashing", () => {
		const h = new TuiHarness({ width: 1, height: 10, chatLines: 20 }).start()
		const rows = screen(h)
		expect(rows).toHaveLength(10)
		for (const line of rows) expect(line.length).toBeLessThanOrEqual(1)
	})
})

describe("Layout: resize", () => {
	test("growing the terminal preserves bottom anchoring and follow", () => {
		const h = new TuiHarness({ width: 80, height: 24, chatLines: 60 }).start()
		expect(h.following).toBe(true)
		h.resize(120, 40)
		const rows = screen(h)
		expect(rows).toHaveLength(40)
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
		expect(h.following).toBe(true)
	})

	test("shrinking the terminal preserves bottom anchoring", () => {
		const h = new TuiHarness({ width: 80, height: 40, chatLines: 60 }).start()
		h.resize(80, 12)
		const rows = screen(h)
		expect(rows).toHaveLength(12)
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
	})

	test("a scrolled-up viewport keeps its position across a width change", () => {
		const h = new TuiHarness({ width: 80, height: 24, chatLines: 60 }).start()
		h.feed("\x1b[5~")
		const scrolled = h.scrollTop
		expect(h.following).toBe(false)
		h.resize(60, 24)
		screen(h)
		// The same content row stays at the top of the viewport.
		expect(h.scrollTop).toBe(scrolled)
		expect(h.following).toBe(false)
	})

	test("resize keeps a multiline composer valid", () => {
		const h = new TuiHarness({ width: 80, height: 24, editorText: "a\nb\nc\nd" }).start()
		h.resize(100, 30)
		const grown = screen(h)
		expect(grown.at(-1)).toBe("FOOTER-2")
		h.resize(40, 10)
		const shrunk = screen(h)
		expect(shrunk).toHaveLength(10)
		expect(shrunk.some(line => /^─+$/.test(line))).toBe(true)
	})
})
