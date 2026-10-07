import type { Component } from "@minicode/tui"
import { displayWidth, truncatePlain } from "../../projection"
import { ansi } from "./theme"

/**
 * The human-facing hello banner shown at the top of an empty transcript.
 *
 * This is the empty-state content of the transcript header: it is the first
 * item in the scroll region, so it scrolls away as conversation output grows
 * and returns when `/new` clears the transcript. It is not a splash screen, it
 * never blocks input, and it owns no lifecycle state.
 *
 * The wordmark is rendered from fixed, measured strings rather than handed to
 * `Text`, so terminal word-wrapping can never split a glyph: every line is
 * centered and padded to exactly the available width. The 5-row and 3-row
 * wordmarks are 47 and 33 columns; the single-line fallback is 8.
 */

/** The full 5-row MINICODE wordmark (47 columns). Every non-space glyph is one cell wide. */
export const WORDMARK_5: readonly string[] = [
	"█   █ █████ █   █ █████  ████  ███  ████  █████",
	"██ ██   █   ██  █   █   █     █   █ █   █ █    ",
	"█ █ █   █   █ █ █   █   █     █   █ █   █ ███  ",
	"█   █   █   █  ██   █   █     █   █ █   █ █    ",
	"█   █ █████ █   █ █████  ████  ███  ████  █████",
]

/** The compact 3-row MINICODE wordmark (33 columns). Every non-space glyph is one cell wide. */
export const WORDMARK_3: readonly string[] = [
	"█▄▄█ ███ █  █ ███ ███ ███ ██  ███",
	"█  █  █  ██ █  █  █   █ █ █ █ ██ ",
	"█  █ ███ █ ██ ███ ███ ███ ██  ███",
]

/** The single-line fallback wordmark (8 columns). */
const WORDMARK_SINGLE = "MINICODE"

/** The product descriptor shown beneath the wordmark (27 columns). */
export const DESCRIPTOR = "an opinionated coding agent"

/** The always-visible keyboard hints, unchanged from the original header. */
export const KEYBOARD_HINTS =
	"enter submit · alt+enter newline · esc interrupt · ctrl+c clear (twice exits) · ctrl+d exit · ctrl+o tools · ctrl+p model · pageup/pagedown scroll · /help commands"

const WORDMARK_5_WIDTH = 47
const WORDMARK_3_WIDTH = 33

/** Blank columns kept on each side when a multi-row wordmark is centered. */
const SIDE_MARGIN = 2

/** Rows owned by the fixed bottom chrome: composer (3) + two footer rows. */
const FIXED_CHROME_ROWS = 5

/** The banner treatments, largest first. */
export type BannerTier = "large" | "medium" | "single"

/** Transcript rows available to the header: terminal rows minus the fixed bottom chrome. */
export function transcriptHeight(terminalRows: number): number {
	return Math.max(0, Math.floor(terminalRows) - FIXED_CHROME_ROWS)
}

/**
 * Greedy word-wrap for plain (uncolored) text. A leading indentation run is
 * preserved on the first line. Matches the framework `Text` wrapping for the
 * header's content, but is applied here so the banner module owns the exact
 * line count used for its height budget.
 */
export function wrapPlain(text: string, width: number): string[] {
	const usable = Math.max(1, width)
	const lead = /^\s+/.exec(text)?.[0] ?? ""
	const words = text.slice(lead.length).split(/\s+/).filter(word => word.length > 0)
	const lines: string[] = []
	let line = ""
	for (const word of words) {
		const candidate = line === "" ? lead + word : `${line} ${word}`
		if (displayWidth(candidate) <= usable) {
			line = candidate
			continue
		}
		if (line !== "") lines.push(line)
		let rest = word
		while (displayWidth(rest) > usable) {
			let cut = ""
			let used = 0
			for (const ch of rest) {
				const cw = displayWidth(ch)
				if (used + cw > usable) break
				cut += ch
				used += cw
			}
			if (cut === "") cut = rest[0] ?? ""
			lines.push(cut)
			rest = rest.slice(cut.length)
		}
		line = rest
	}
	if (line !== "") lines.push(line)
	return lines.length > 0 ? lines : [lead]
}

/** Pads styled content to a full width, given its already-measured visible width. */
function padTo(width: number, content: string, visible: number): string {
	return content + " ".repeat(Math.max(0, width - visible))
}

/** A left-aligned, width-clipped, styled line. */
function leftLine(text: string, style: (value: string) => string, width: number): string {
	const clipped = displayWidth(text) > width ? truncatePlain(text, width) : text
	return padTo(width, style(clipped), displayWidth(clipped))
}

/** A centered, width-clipped, styled line. */
function centerLine(text: string, style: (value: string) => string, width: number): string {
	const clipped = displayWidth(text) > width ? truncatePlain(text, width) : text
	const visible = displayWidth(clipped)
	const left = Math.max(0, Math.floor((width - visible) / 2))
	return " ".repeat(left) + style(clipped) + " ".repeat(Math.max(0, width - left - visible))
}

/** A blank line padded to a full width. */
function blankLine(width: number): string {
	return " ".repeat(width)
}

/** Renders fixed-width wordmark rows, centered as a block so columns stay aligned. */
function renderArt(art: readonly string[], artWidth: number, width: number): string[] {
	const offset = Math.max(0, Math.floor((width - artWidth) / 2))
	return art.map(row => {
		const left = Math.min(offset, Math.max(0, width))
		const clipped = displayWidth(row) > width - left ? truncatePlain(row, Math.max(0, width - left)) : row
		const visible = displayWidth(clipped)
		return " ".repeat(left) + ansi.bold(ansi.cyan(clipped)) + " ".repeat(Math.max(0, width - left - visible))
	})
}

/** Inputs to the deterministic tier choice. */
export interface BannerTierInput {
	readonly width: number
	readonly availableHeight: number
	readonly labelRows: number
	readonly hintRows: number
}

/**
 * Chooses the largest treatment whose full composition fits both the available
 * width and the available transcript height. Thresholds are derived from the
 * measured wordmark widths plus a fixed side margin, not a fixed column count.
 */
export function selectBannerTier(input: BannerTierInput): BannerTier {
	const { width, availableHeight, labelRows, hintRows } = input
	// After the wordmark: a blank, the descriptor + a blank when it fits, then
	// the label; the hints follow. Kept identical to the full composition below.
	const afterArtRows = displayWidth(DESCRIPTOR) <= width ? 3 : 1
	const full = (artRows: number): number => artRows + afterArtRows + labelRows + hintRows
	if (width >= WORDMARK_5_WIDTH + SIDE_MARGIN * 2 && full(WORDMARK_5.length) <= availableHeight) {
		return "large"
	}
	if (width >= WORDMARK_3_WIDTH + SIDE_MARGIN * 2 && full(WORDMARK_3.length) <= availableHeight) {
		return "medium"
	}
	return "single"
}

export interface HelloHeaderInput {
	readonly width: number
	/** Transcript rows available at idle (see {@link transcriptHeight}). */
	readonly availableHeight: number
	/** Workspace path, or a resumed session id — whatever the old title line showed. */
	readonly label: string
	/** The keyboard-hints line, unwrapped. */
	readonly hints: string
}

/**
 * Renders the complete empty-state header: wordmark, descriptor, label, hints.
 * Every returned line is exactly the available width, so no downstream text
 * wrapping can split the wordmark.
 */
export function renderHelloHeader(input: HelloHeaderInput): string[] {
	const width = Math.max(1, Math.floor(input.width))
	const height = Math.max(0, Math.floor(input.availableHeight))
	const hintLines = wrapPlain(`  ${input.hints}`, width)
	const labelLines = wrapPlain(`  ${input.label}`, width)
	const tier = selectBannerTier({
		width,
		availableHeight: height,
		labelRows: labelLines.length,
		hintRows: hintLines.length,
	})

	const artLines = tier === "large"
		? renderArt(WORDMARK_5, WORDMARK_5_WIDTH, width)
		: tier === "medium"
			? renderArt(WORDMARK_3, WORDMARK_3_WIDTH, width)
			: [centerLine(WORDMARK_SINGLE, value => ansi.bold(ansi.cyan(value)), width)]

	const descLine = displayWidth(DESCRIPTOR) <= width
		? centerLine(DESCRIPTOR, value => ansi.gray(value), width)
		: null
	const styledLabel = labelLines.map(line => leftLine(line, value => ansi.gray(value), width))
	const styledHints = hintLines.map(line => leftLine(line, value => ansi.gray(value), width))

	// Full composition: wordmark, descriptor, label, then hints.
	const full = [
		...artLines,
		blankLine(width),
		...(descLine !== null ? [descLine, blankLine(width)] : []),
		...styledLabel,
		...styledHints,
	]
	if (full.length <= height) return full

	// Short terminals: keep the wordmark and hints, dropping spacing, descriptor,
	// then the label before giving up on the brand.
	const noGaps = [
		...artLines,
		...(descLine !== null ? [descLine] : []),
		...styledLabel,
		...styledHints,
	]
	if (noGaps.length <= height) return noGaps

	return [...artLines, ...styledHints]
}

/**
 * Width- and height-aware empty-state header component. Height is read lazily
 * from the live terminal so it reflects resizes without any lifecycle state.
 */
export class HelloHeader implements Component {
	constructor(
		private readonly options: {
			label: string
			hints: string
			availableHeight: () => number
		},
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		return renderHelloHeader({
			width,
			availableHeight: this.options.availableHeight(),
			label: this.options.label,
			hints: this.options.hints,
		})
	}
}

/** Builds the interactive TUI's empty-state header. */
export function helloHeader(options: {
	label: string
	hints: string
	availableHeight: () => number
}): Component {
	return new HelloHeader(options)
}
