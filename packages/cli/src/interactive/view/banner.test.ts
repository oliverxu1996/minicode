import { describe, expect, test } from "bun:test"
import { Text, type Component } from "@loongcode/tui"
import { Session } from "@loongcode/agent"
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

/** Strip ANSI and trailing padding so a rendered line compares to a screen row. */
const stripLines = (lines: readonly string[]): string[] => lines.map(line => strip(line).trimEnd())

function renderedHeader(width: number, availableHeight: number): string[] {
	return stripLines(headerLines(width, availableHeight))
}

function leadingBlankRows(lines: readonly string[]): number {
	let rows = 0
	while (rows < lines.length && lines[rows]!.trim() === "") rows += 1
	return rows
}

/** Asserts the rendered hero group is vertically centered in the viewport. */
function assertVerticallyCentered(lines: readonly string[], viewport: number): void {
	// The chosen composition must fit, otherwise it cannot be centered.
	expect(lines.length).toBeLessThanOrEqual(viewport)
	const top = leadingBlankRows(lines)
	const groupRows = lines.length - top
	const bottom = viewport - lines.length
	// The group's actual rendered height drives the offset, not a fixed padding.
	expect(top).toBe(Math.floor((viewport - groupRows) / 2))
	// Slack is even, at worst off by the unavoidable odd row.
	expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1)
}

/** The centered horizontal padding on a rendered hero line. */
function horizontalPadding(line: string): { left: number; right: number } {
	const visible = strip(line)
	const leading = visible.length - visible.trimStart().length
	const trailing = visible.length - visible.trimEnd().length
	return { left: displayWidth(visible.slice(0, leading)), right: displayWidth(visible.slice(visible.length - trailing)) }
}

/** Strip the scrollbar glyph the renderer paints over the last column. */
const cleanRow = (line: string): string => line.replace(/[│┃]\s*$/, "").trimEnd()

const PTY_MATRIX: ReadonlyArray<readonly [number, number]> = [
	[100, 30],
	[80, 24],
	[60, 20],
	[46, 20],
	[34, 12],
	[24, 10],
	[16, 6],
]

/** The banner component wired to the harness terminal, as the app wires it. */
function liveBanner(terminal: { rows: number }): Component {
	return helloHeader({
		label: LABEL,
		hints: KEYBOARD_HINTS,
		availableHeight: () => transcriptHeight(terminal.rows),
	})
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
		// 5-row wordmark is 53 columns; two columns of margin each side -> 57.
		expect(selectBannerTier({ ...input, width: 56 })).toBe("medium")
		expect(selectBannerTier({ ...input, width: 57 })).toBe("large")
		// 3-row wordmark is 37 columns; 37 + 4 -> 41.
		expect(selectBannerTier({ ...input, width: 40 })).toBe("single")
		expect(selectBannerTier({ ...input, width: 41 })).toBe("medium")
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
		expect(plain(lines).some(line => line.trim() === "LOONGCODE")).toBe(true)
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
		// From the narrowest width that can hold the 9-column single-line
		// fallback. Below that the wordmark is clipped by `centerLine` — the
		// same policy the label and descriptor already follow for text that
		// cannot fit — and the width-safety test above still holds.
		for (let width = 9; width <= 200; width++) {
			const lines = headerLines(width, 25)
			const tier = selectBannerTier({ width, availableHeight: 25, labelRows: labelRows(width), hintRows: hintRows(width) })
			const rows = tier === "large" ? WORDMARK_5 : tier === "medium" ? WORDMARK_3 : ["LOONGCODE"]
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

	test("omitting the visibility predicate keeps the header rendered", () => {
		const component = helloHeader({ label: LABEL, hints: KEYBOARD_HINTS, availableHeight: () => 19 })
		expect(component.render(80).length).toBeGreaterThan(0)
	})

	test("a false visibility predicate contributes zero rows", () => {
		const component = helloHeader({
			label: LABEL,
			hints: KEYBOARD_HINTS,
			availableHeight: () => 19,
			visible: () => false,
		})
		expect(component.render(80)).toEqual([])
	})

	test("visibility is re-read on every render", () => {
		let visible = true
		const component = helloHeader({
			label: LABEL,
			hints: KEYBOARD_HINTS,
			availableHeight: () => 19,
			visible: () => visible,
		})
		expect(component.render(80)).toEqual(headerLines(80, 19))
		visible = false
		expect(component.render(80)).toEqual([])
		visible = true
		expect(component.render(80)).toEqual(headerLines(80, 19))
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

describe("hello banner — hero centering", () => {
	test("the whole hero group is vertically centered in the transcript viewport", () => {
		for (const [width, height] of PTY_MATRIX) {
			const viewport = transcriptHeight(height)
			assertVerticallyCentered(renderedHeader(width, viewport), viewport)
		}
	})

	test("each tier is centered as its actual rendered group height, not a fixed offset", () => {
		const viewport = transcriptHeight(30)
		// Same viewport, different compositions (large/medium/single) and,
		// among the large ones, different rendered heights.
		const groups = [
			renderedHeader(100, viewport),
			renderedHeader(80, viewport),
			renderedHeader(34, viewport),
		]
		const heights = groups.map(lines => lines.length - leadingBlankRows(lines))
		expect(new Set(heights).size).toBeGreaterThan(1)
		for (const lines of groups) {
			const top = leadingBlankRows(lines)
			const groupRows = lines.length - top
			expect(top).toBe(Math.floor((viewport - groupRows) / 2))
			expect(Math.abs(top - (viewport - lines.length))).toBeLessThanOrEqual(1)
		}
		// The offset follows the group's height, so it is not a fixed constant.
		expect(new Set(groups.map(leadingBlankRows)).size).toBeGreaterThan(1)
	})

	test("a group taller than the viewport is top-anchored, never pushed off the top", () => {
		const lines = renderedHeader(16, 1)
		expect(lines).toHaveLength(1)
		expect(leadingBlankRows(lines)).toBe(0)
		expect(lines[0]).toContain("LOONGCODE")
	})

	test("very short viewports keep a centered single-line wordmark rather than clipped hints", () => {
		const viewport = transcriptHeight(10)
		const lines = renderedHeader(24, viewport)
		expect(lines.some(line => line.trim() === "LOONGCODE")).toBe(true)
		expect(lines.some(line => line.includes("enter submit"))).toBe(false)
		assertVerticallyCentered(lines, viewport)
	})

	test("the wordmark is horizontally centered within the available width", () => {
		for (const [width] of PTY_MATRIX) {
			// Keep trailing padding so the right margin can be measured.
			const lines = headerLines(width, transcriptHeight(30)).map(strip)
			const artRow = lines.find(line => line.includes("█")) ?? lines.find(line => line.trim() === "LOONGCODE")
			expect(artRow).toBeDefined()
			const pad = horizontalPadding(artRow!)
			expect(Math.abs(pad.left - pad.right)).toBeLessThanOrEqual(1)
		}
	})
})

describe("hello banner — transcript-viewport centering integration (PTY matrix)", () => {
	for (const [width, height] of PTY_MATRIX) {
		test(`${width}×${height} centers the hero in the transcript area`, () => {
			const h = new TuiHarness({
				width,
				height,
				chatLines: 0,
				headerComponent: terminal => liveBanner(terminal),
			}).start()
			const rows = h.screen()
			const viewport = transcriptHeight(height)
			expect(h.viewportHeight).toBe(viewport)

			// 1 & 2: horizontally centered lines and a vertically centered group.
			const expected = renderedHeader(width, viewport)
			assertVerticallyCentered(expected, viewport)
			expect(rows.slice(0, expected.length)).toEqual(expected)

			// 3 & 4: the bottom chrome is unchanged and the hero cannot reach it.
			expect(rows.at(-1)).toBe("FOOTER-2")
			expect(rows.at(-2)).toBe("FOOTER-1")
			expect(rows.at(-3)).toMatch(/^─+$/) // composer bottom border
			expect(rows.at(-5)).toMatch(/^─+$/) // composer top border
			expect(expected.length).toBeLessThanOrEqual(viewport)

			// 1 (again, at the real render width): the wordmark is horizontally
			// centered, measured on the untrimmed line so the right margin shows.
			const art = headerLines(width, viewport)
				.map(strip)
				.find(line => line.includes("█") || line.trim() === "LOONGCODE")
			expect(art).toBeDefined()
			const pad = horizontalPadding(art!)
			expect(Math.abs(pad.left - pad.right)).toBeLessThanOrEqual(1)
		})
	}

	test("resizing re-centers the hero without leaving stale positioning", () => {
		const h = new TuiHarness({
			width: 80,
			height: 24,
			chatLines: 0,
			headerComponent: terminal => liveBanner(terminal),
		}).start()
		h.resize(46, 20)
		const shrunk = h.screen()
		const shrunkViewport = transcriptHeight(20)
		expect(h.viewportHeight).toBe(shrunkViewport)
		const shrunkExpected = renderedHeader(46, shrunkViewport)
		assertVerticallyCentered(shrunkExpected, shrunkViewport)
		expect(shrunk.slice(0, shrunkExpected.length)).toEqual(shrunkExpected)
		expect(shrunk.at(-1)).toBe("FOOTER-2")

		h.resize(100, 30)
		const grown = h.screen()
		const grownViewport = transcriptHeight(30)
		const grownExpected = renderedHeader(100, grownViewport)
		assertVerticallyCentered(grownExpected, grownViewport)
		expect(grown.slice(0, grownExpected.length)).toEqual(grownExpected)
		expect(grown.at(-1)).toBe("FOOTER-2")
	})
})

describe("hello banner — empty-state lifecycle", () => {
	/**
	 * A harness whose hero is driven by the real app predicate,
	 * `session.messages.length === 0 && !running`, evaluated against an actual
	 * `Session` and a mutable run flag.
	 *
	 * `session.current` can be replaced to model `/new` or a session switch, so
	 * the tests exercise the exact expression the app wires in `app.ts`.
	 */
	function heroHarness(options: {
		messages?: number
		running?: boolean
		width?: number
		height?: number
		chatLines?: number
		statusRows?: number
	}): { h: TuiHarness; session: { current: Session }; state: { running: boolean } } {
		const session = { current: Session.create({ cwd: LABEL }) }
		for (let i = 0; i < (options.messages ?? 0); i++) session.current.pushUser(`message ${i}`)
		const state = { running: options.running ?? false }
		const h = new TuiHarness({
			width: options.width ?? 80,
			height: options.height ?? 24,
			chatLines: options.chatLines ?? 0,
			statusRows: options.statusRows,
			headerComponent: terminal =>
				helloHeader({
					label: LABEL,
					hints: KEYBOARD_HINTS,
					availableHeight: () => transcriptHeight(terminal.rows),
					visible: () => session.current.messages.length === 0 && !state.running,
				}),
		}).start()
		return { h, session, state }
	}

	test("A. an empty, idle session renders the centered hero", () => {
		const { h } = heroHarness({ messages: 0, running: false })
		const rows = h.screen()
		expect(rows.join("\n")).toContain("█")
		expect(rows.join("\n")).toContain(DESCRIPTOR)
	})

	test("B. a submission hides the hero before and after the message lands", () => {
		const { h, session, state } = heroHarness({ messages: 0 })
		expect(h.screen().join("\n")).toContain("█")

		// `running` flips synchronously when submission starts, before the
		// session records the user message, so the hero is gone immediately.
		state.running = true
		expect(h.screen().join("\n")).not.toContain("█")

		// The runtime records the message; the durable predicate keeps it hidden.
		session.current.pushUser("Fix the authentication bug.")
		state.running = false
		expect(h.screen().join("\n")).not.toContain("█")
	})

	test("C. a session with messages has no hero in its transcript content", () => {
		const { h } = heroHarness({ messages: 1, chatLines: 60 })
		// At the very top of the scroll content the first item is conversation,
		// not the hero. The original bug was the hero being reachable here.
		h.feed("\x1b[1~") // Home
		const rows = h.screen()
		expect(cleanRow(rows[0]!)).toBe("chat-0")
		expect(rows.join("\n")).not.toContain("█")
		expect(rows.join("\n")).not.toContain("LOONGCODE")
	})

	test("D. /new restores the hero, and a notice does not suppress it", () => {
		const { h, session } = heroHarness({ messages: 1, chatLines: 12 })
		expect(h.screen().join("\n")).not.toContain("█")

		// `/new` swaps in an empty session and also appends a "started a new
		// session" notice. Emptiness is the session's, not the chat container's,
		// so the notice must not keep the hero hidden.
		session.current = Session.create({ cwd: LABEL })
		h.chat.count = 1 // the notice
		const rows = h.screen()
		expect(rows.join("\n")).toContain("█")
		expect(rows.join("\n")).toContain("chat-0")
	})

	test("E. a short session that fits the viewport still shows no hero", () => {
		const { h } = heroHarness({ messages: 2, chatLines: 3 })
		const rows = h.screen()
		expect(cleanRow(rows[0]!)).toBe("chat-0")
		expect(rows.join("\n")).not.toContain("█")
	})

	test("F. a long session's hero cannot be revealed through scrollback", () => {
		const { h } = heroHarness({ messages: 2, chatLines: 80 })
		// Home, then further upward attempts: nothing above chat-0.
		for (const key of ["\x1b[1~", "\x1b[5~", "\x1b[<64;10;10M"]) h.feed(key)
		const rows = h.screen()
		expect(cleanRow(rows[0]!)).toBe("chat-0")
		expect(rows.join("\n")).not.toContain("█")
	})

	test("G. hiding the hero leaves the bottom chrome and focus unchanged", () => {
		const { h } = heroHarness({ messages: 2, chatLines: 40, statusRows: 2 })
		const rows = h.screen()
		expect(rows.at(-1)).toBe("FOOTER-2")
		expect(rows.at(-2)).toBe("FOOTER-1")
		expect(rows.at(-3)).toMatch(/^─+$/) // composer bottom border
		expect(rows.at(-5)).toMatch(/^─+$/) // composer top border
		expect(rows.join("\n")).toContain("STATUS-0")
		expect(h.tui.getFocusedComponent()).toBe(h.editor)
	})

	test("H. resize keeps a visible hero centered and a hidden hero absent", () => {
		const visible = heroHarness({ messages: 0 })
		visible.h.resize(46, 20)
		const viewport = transcriptHeight(20)
		const expected = renderedHeader(46, viewport)
		assertVerticallyCentered(expected, viewport)
		expect(visible.h.screen().slice(0, expected.length)).toEqual(expected)

		const hidden = heroHarness({ messages: 2, chatLines: 40 })
		hidden.h.resize(100, 30)
		const rows = hidden.h.screen()
		expect(rows.join("\n")).not.toContain("█")
		expect(rows.at(-1)).toBe("FOOTER-2")
	})
})

describe("hello banner — wordmark geometry", () => {
	test("each wordmark is drawn to its declared width, one cell per glyph", () => {
		expect(WORDMARK_5).toHaveLength(5)
		expect(WORDMARK_3).toHaveLength(3)
		// The widths the tier thresholds are derived from. A redrawn wordmark
		// must change these deliberately, not by accident.
		for (const row of WORDMARK_5) expect(displayWidth(row)).toBe(53)
		for (const row of WORDMARK_3) expect(displayWidth(row)).toBe(37)
		// Every glyph is one cell wide, so centering can never split one, and
		// each row carries ink.
		for (const row of [...WORDMARK_5, ...WORDMARK_3]) {
			for (const glyph of row) expect(displayWidth(glyph)).toBeLessThanOrEqual(1)
			expect(row.trim().length).toBeGreaterThan(0)
		}
	})
})
