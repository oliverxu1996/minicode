import { Container, ScrollView, VStack, type Component } from "@minicode/tui"

/**
 * The pieces the interactive TUI pins around its scrollable conversation.
 *
 * `header` and `chat` are conversation content: they live inside the
 * `ScrollView` so the header scrolls away with the transcript. `status`,
 * `picker`, `editor`, and the two footer rows are fixed bottom chrome. The
 * `picker` is empty (zero rows) until a transient selector is opened.
 */
export interface TuiLayoutParts {
	header: Component
	chat: Component
	status: Component
	/** Bottom-attached transient picker; renders zero rows when closed. */
	picker: Component
	editor: Component
	footerRow1: Component
	footerRow2: Component
}

export interface TuiLayout {
	/** Root component mounted on the fullscreen renderer. */
	root: VStack
	/** Scrollable container holding the header followed by the conversation. */
	transcript: Container
	/** The application-owned conversation viewport. */
	scroll: ScrollView
}

/**
 * Compose the approved MiniCode TUI layout:
 *
 * ```text
 * VStack
 * ├── ScrollView           grow: 1, shrink: 1   ← only the conversation scrolls
 * │   ├── Header
 * │   └── Conversation
 * ├── Status               shrink: 0
 * ├── Picker               shrink: 0   ← transient, zero rows when closed
 * ├── Composer             shrink: 0
 * ├── Footer row 1         shrink: 0
 * └── Footer row 2         shrink: 0
 * ```
 *
 * The scroll entry takes all surplus height and is the only region allowed to
 * shrink, so the fixed regions never collapse because the conversation grew.
 * `follow: "end"` makes the viewport track streamed output while pinned to the
 * bottom and release when the user scrolls up.
 *
 * The picker sits immediately above the composer: when it opens, its own fixed
 * height is taken from the scroll entry, so it consumes conversation viewport
 * space instead of floating over the conversation.
 */
export function buildTuiLayout(parts: TuiLayoutParts): TuiLayout {
	const transcript = new Container()
	transcript.addChild(parts.header)
	transcript.addChild(parts.chat)

	const scroll = new ScrollView(transcript, { follow: "end", primary: true, scrollbar: "auto" })

	const root = new VStack([
		{ component: scroll, grow: 1, shrink: 1 },
		{ component: parts.status, shrink: 0 },
		{ component: parts.picker, shrink: 0 },
		{ component: parts.editor, shrink: 0 },
		{ component: parts.footerRow1, shrink: 0 },
		{ component: parts.footerRow2, shrink: 0 },
	])

	return { root, transcript, scroll }
}
