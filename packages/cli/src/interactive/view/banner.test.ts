import { describe, expect, test } from "bun:test"
import { Text } from "@minicode/tui"
import { displayWidth } from "../../projection"
import { TuiHarness } from "./testing"
import {
	DESCRIPTOR,
	HelloHeader,
	KEYBOARD_HINTS,
	WORDMARK_3,
	WORDMARK_5,
	helloHeader,
	renderHelloHeader,
	selectBannerTier,
	transcriptHeight,
	wrapPlain,
} from "./banner"

const LABEL = "/tmp/project"

/** Strip ANSI so a rendered line can be measured as visible text. */
const strip = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "")
const plain = (lines: readonly string[]): string[] => lines.map(strip)
const visibleWidth = (line: string): number => displayWidth(strip(line))

function headerLines(width: number, availableHeight: number): string[] {
	return renderHelloHeader({ width, availableHeight, label: LABEL, hints: KEYBOARD_HINTS })
}

function hintRows(width: number): number {
	return wrapPlain(`  ${KEYBOARD_HINTS}`, width).length
}

function labelRows(width: number): number {
	return wrapPlain(`  ${LABEL}`, width).length
}

function tierAt(width: number, terminalRows: number): string {
	const availableHeight = transcriptHeight(terminalRows)
	return selectBannerTier({ width, availableHeight, labelRows: labelRows(width), hintRows: hintRows(width) })
}

describe("hello banner — tier selection", () => {
	test("transcript height is terminal rows minus the fixed bottom chrome", () => {
		expect(transcriptHeight(30)).toBe(25)
		expect(transcriptHeight(24)).toBe(19)
		expect(transcriptHeight(5)).toBe(0)
		expect(transcriptHeight(3)).toBe(0)
	})

	test("thresholds derive from the measured wordmark widths, not a fixed breakpoint", () => {
		const input = { availableHeight: 100, labelRows: 1, hintRows: 3 }
		// 5-row wordmark is 47 columns; two columns of margin each side -> 51.
		expect(selectBannerTier({ ...input, width: 50 })).toBe("medium")
		expect(selectBannerTier({ ...input, width: 51 })).toBe("large")
		// 3-row wordmark is 33 columns; 33 + 4 -> 37.
		expect(selectBannerTier({ ...input, width: 36 })).toBe("single")
		expect(selectBannerTier({ ...input, width: 37 })).toBe("medium")
	})

	test("a short terminal falls back even when the width allows the larger treatment", () => {
		const input = { width: 100, labelRows: 1, hintRows: 3 }
		// large full = 5 art + 3 (blank/descriptor/blank) + 1 label + 3 hints = 12.
		expect(selectBannerTier({ ...input, availableHeight: 12 })).toBe("large")
		expect(selectBannerTier({ ...input, availableHeight: 11 })).toBe("medium")
		// medium full = 3 + 3 + 1 + 3 = 10.
		expect(selectBannerTier({ ...input, availableHeight: 9 })).toBe("single")
	})

	test("the PTY matrix maps to the expected tiers", () => {
		expect(tierAt(100, 30)).toBe("large")
		expect(tierAt(80, 24)).toBe("large")
		expect(tierAt(60, 20)).toBe("large")
		expect(tierAt(46, 20)).toBe("medium")
		expect(tierAt(34, 12)).toBe("single")
		expect(tierAt(24, 10)).toBe("single")
		expect(tierAt(16, 6)).toBe("single")
	})
})

describe("hello banner — content", () => {
	test("the large tier renders the 5-row wordmark, descriptor and label", () => {
		const lines = headerLines(80, 19)
		expect(tierAt(80, 24)).toBe("large")
		for (const row of WORDMARK_5) expect(plain(lines).some(line => line.includes(row))).toBe(true)
		expect(plain(lines).some(line => line.trim() === DESCRIPTOR)).toBe(true)
		expect(plain(lines).some(line => line.includes(LABEL))).toBe(true)
	})

	test("the medium tier renders the 3-row wordmark", () => {
		const lines = headerLines(46, 15)
		for (const row of WORDMARK_3) expect(plain(lines).some(line => line.includes(row))).toBe(true)
		expect(plain(lines).some(line => line.includes(WORDMARK_5[0]!))).toBe(false)
	})

	test("narrow terminals fall back to the single-line wordmark", () => {
		const lines = headerLines(30, 11)
		expect(plain(lines).some(line => line.trim() === "MINICODE")).toBe(true)
		expect(plain(lines).some(line => line.includes("█"))).toBe(false)
	})

	test("the descriptor is one line and omitted when it cannot fit without wrapping", () => {
		const wide = plain(headerLines(80, 19))
		expect(wide.filter(line => line.trim() === DESCRIPTOR)).toHaveLength(1)
		// 27 columns of descriptor cannot fit in 24 columns.
		const narrow = plain(headerLines(24, 5))
		expect(narrow.some(line => line.includes("opinionated"))).toBe(false)
	})

	test("every wordmark glyph is a single cell wide (no CJK/emoji surprises)", () => {
		for (const row of [...WORDMARK_5, ...WORDMARK_3]) {
			for (const glyph of row) {
				if (glyph === " ") continue
				expect(displayWidth(glyph)).toBe(1)
			}
		}
	})
})

describe("hello banner — width and height safety", () => {
	test("no rendered line exceeds the available width, across widths and heights", () => {
		const widths: number[] = []
		for (let width = 8; width <= 72; width++) widths.push(width)
		for (const width of [80, 100, 120, 160, 200]) widths.push(width)
		const heights = [1, 5, 7, 10, 15, 19, 25]
		for (const width of widths) {
			for (const availableHeight of heights) {
				const lines = headerLines(width, availableHeight)
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width)
				}
			}
		}
	})

	test("the wordmark is never split across lines at any width", () => {
		for (let width = 8; width <= 200; width++) {
			const lines = headerLines(width, 25)
			const tier = selectBannerTier({ width, availableHeight: 25, labelRows: labelRows(width), hintRows: hintRows(width) })
			const rows = tier === "large" ? WORDMARK_5 : tier === "medium" ? WORDMARK_3 : ["MINICODE"]
			for (const row of rows) {
				expect(plain(lines).some(line => line.includes(row))).toBe(true)
			}
		}
	})

	test("the keyboard hints render exactly as the framework Text used to wrap them", () => {
		for (const width of [16, 24, 30, 34, 46, 60, 80, 100, 160]) {
			const reference = new Text(`  ${KEYBOARD_HINTS}`, 0, 0).render(width).map(line => line.trimEnd())
			const lines = headerLines(width, transcriptHeight(30))
			const rendered = plain(lines).slice(-reference.length).map(line => line.trimEnd())
			expect(rendered).toEqual(reference)
		}
	})
})

describe("hello banner — component", () => {
	test("HelloHeader renders the pure header for the live height", () => {
		const component = new HelloHeader({ label: LABEL, hints: KEYBOARD_HINTS, availableHeight: () => 19 })
		expect(component.render(80)).toEqual(headerLines(80, 19))
	})

	test("helloHeader returns a component that honours the height provider", () => {
		let height = 19
		const component = helloHeader({ label: LABEL, hints: KEYBOARD_HINTS, availableHeight: () => height })
		expect(component.render(80)).toEqual(headerLines(80, 19))
		height = 5
		expect(component.render(80)).toEqual(headerLines(80, 5))
	})
})

describe("hello banner — transcript integration", () => {
	const header = helloHeader({ label: LABEL, hints: KEYBOARD_HINTS, availableHeight: () => transcriptHeight(24) })

	test("an empty transcript shows the banner and leaves the bottom chrome intact", () => {
		const h = new TuiHarness({ width: 80, height: 24, chatLines: 0, headerComponent: header }).start()
		const rows = h.screen()
		const screen = rows.join("\n")
		expect(screen).toContain("█")
		expect(screen).toContain(DESCRIPTOR)
		expect(screen).toContain("enter submit")
		// Composer and both footer rows are untouched at the bottom.
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
		expect(rows.at(-3)).toMatch(/^─+$/) // composer bottom border
		expect(rows.at(-4)).toBe("") // composer content
		expect(rows.at(-5)).toMatch(/^─+$/) // composer top border
	})

	test("conversation history scrolls the banner away, and clearing restores it (/new)", () => {
		const h = new TuiHarness({ width: 80, height: 24, chatLines: 0, headerComponent: header }).start()
		expect(h.screen().join("\n")).toContain("█")

		// A session with existing messages: the banner is transcript content, so
		// it scrolls off rather than pinning as persistent chrome.
		h.chat.count = 60
		const busy = h.screen()
		expect(busy.join("\n")).not.toContain("█")
		expect(busy.at(-1)).toBe("FOOTER-2")

		// `/new` clears the transcript; the empty-state banner naturally returns.
		h.chat.count = 0
		expect(h.screen().join("\n")).toContain("█")
	})

	test("the banner coexists with the status area and never displaces it", () => {
		const h = new TuiHarness({
			width: 80,
			height: 24,
			chatLines: 0,
			statusRows: 2,
			headerComponent: header,
		}).start()
		const rows = h.screen()
		expect(rows.join("\n")).toContain("█")
		expect(rows.join("\n")).toContain("STATUS-0")
		expect(rows.at(-1)).toBe("FOOTER-2")
	})
})
