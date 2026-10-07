import { Editor, ScrollView, TuiAltScreen, type Component, type Terminal } from "@minicode/tui"
import { buildTuiLayout } from "./layout"
import { PickerSlot, Selector, pickerVisibleItems, type SelectorItem } from "./selector"

/**
 * Test support for the fullscreen TUI layout.
 *
 * This is not production code. It mounts the real `TuiAltScreen` renderer and
 * the real `buildTuiLayout` composition against a mock terminal, then
 * reconstructs the exact screen rows the renderer emitted. Tests therefore
 * exercise the actual renderer/layout/scroll/keyboard paths rather than calling
 * private component methods.
 */

/** A component with a fixed set of lines. */
export class FixedLines implements Component {
	constructor(private readonly lines: string[]) {}

	render(_width: number): string[] {
		return this.lines
	}

	invalidate(): void {}
}

/** A component whose line count can grow, to simulate streamed transcript output. */
export class GrowableLines implements Component {
	constructor(
		public count: number,
		private readonly tag = "chat",
	) {}

	render(_width: number): string[] {
		return Array.from({ length: this.count }, (_, index) => `${this.tag}-${index}`)
	}

	invalidate(): void {}
}

export interface TuiHarnessOptions {
	width?: number
	height?: number
	/** Number of synthetic conversation lines. */
	chatLines?: number
	/** Number of header lines (0 to omit the header). */
	headerRows?: number
	/** Replaces the synthetic header with a real component (banner integration tests). */
	headerComponent?: Component | ((terminal: Terminal) => Component)
	/** Number of status lines (2 simulates the spinner). */
	statusRows?: number
	editorText?: string
}

/** Strip ANSI/OSC/APC sequences so a rendered line can be compared as text. */
export function stripSequences(value: string): string {
	return value
		.replace(/\x1b_[^\x07]*\x07/g, "") // APC (cursor marker)
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
		.replace(/\x1b[@-Z\\-_]/g, "") // remaining two-char escapes
}

/**
 * Parse the renderer's emitted bytes into screen rows, preserving ANSI codes.
 * `TuiAltScreen` writes each changed row as `CSI <row>;1H [2K <line>`, so the
 * last write per row wins.
 */
export function parseRawScreen(raw: string, height: number): string[] {
	const screen = Array.from({ length: height }, () => "")
	const marker = /\x1b\[(\d+);1H/g
	const positions: Array<{ row: number; index: number; after: number }> = []
	let match: RegExpExecArray | null
	while ((match = marker.exec(raw)) !== null) {
		positions.push({ row: Number.parseInt(match[1]!, 10) - 1, index: match.index, after: marker.lastIndex })
	}
	for (let i = 0; i < positions.length; i++) {
		const { row, after } = positions[i]!
		const end = i + 1 < positions.length ? positions[i + 1]!.index : raw.length
		if (row < 0 || row >= height) continue
		screen[row] = raw.slice(after, end)
	}
	return screen
}

/** Parse the emitted bytes into plain-text screen rows (ANSI stripped). */
export function parseScreen(raw: string, height: number): string[] {
	return parseRawScreen(raw, height).map(line => stripSequences(line).trimEnd())
}

/**
 * Drives the real fullscreen TUI composition for tests.
 *
 * `feed()` delivers raw terminal bytes through the real input path (input
 * listeners + focused component); `screen()` forces a full render and returns
 * the resulting rows.
 */
export class TuiHarness {
	readonly terminal: Terminal
	readonly tui: TuiAltScreen
	readonly editor: Editor
	readonly scroll: ScrollView
	readonly header: GrowableLines
	readonly chat: GrowableLines
	readonly picker: PickerSlot
	readonly status: Component
	readonly footerRow1: Component
	readonly footerRow2: Component
	readonly submitted: string[] = []

	private columnsValue: number
	private rowsValue: number
	private readonly writes: string[] = []
	private send: ((data: string) => void) | undefined
	private started = false

	constructor(options: TuiHarnessOptions = {}) {
		this.columnsValue = options.width ?? 80
		this.rowsValue = options.height ?? 24

		const harness = this
		this.terminal = {
			start(onInput) {
				harness.send = onInput
			},
			stop() {},
			async drainInput() {},
			write(data: string) {
				harness.writes.push(data)
			},
			get columns() {
				return harness.columnsValue
			},
			get rows() {
				return harness.rowsValue
			},
			get kittyProtocolActive() {
				return false
			},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			setProgress() {},
		}

		this.tui = new TuiAltScreen(this.terminal, false, undefined, { mouse: true })

		this.header = new GrowableLines(options.headerRows ?? 2, "header")
		this.chat = new GrowableLines(options.chatLines ?? 0, "chat")
		this.status =
			options.statusRows && options.statusRows > 0
				? new FixedLines(Array.from({ length: options.statusRows }, (_, i) => `STATUS-${i}`))
				: new FixedLines([])

		this.editor = new Editor(this.tui, {
			borderColor: text => text,
			selectList: {
				selectedPrefix: text => text,
				selectedText: text => text,
				description: text => text,
				scrollInfo: text => text,
				noMatch: text => text,
			},
		})
		this.editor.onSubmit = text => {
			this.submitted.push(text)
		}
		if (options.editorText !== undefined) this.editor.setText(options.editorText)

		this.picker = new PickerSlot(() => pickerVisibleItems(this.rowsValue))
		this.footerRow1 = new FixedLines(["FOOTER-1"])
		this.footerRow2 = new FixedLines(["FOOTER-2"])
		const requestedHeader = options.headerComponent
		const header = typeof requestedHeader === "function" ? requestedHeader(this.terminal) : requestedHeader ?? this.header
		const layout = buildTuiLayout({
			header,
			chat: this.chat,
			status: this.status,
			picker: this.picker,
			editor: this.editor,
			footerRow1: this.footerRow1,
			footerRow2: this.footerRow2,
		})
		this.scroll = layout.scroll
		this.tui.setLayoutRoot(layout.root)
		this.tui.setFocus(this.editor)
	}

	/**
	 * Open a selector in the bottom-attached picker slot, mirroring the
	 * application's pick path (slot contents + focus). Returns the focused
	 * selector so tests can drive it, and reports the chosen value.
	 */
	openPicker(title: string, items: SelectorItem[], onResult?: (value: string | null) => void): Selector {
		const selector = new Selector(title, items)
		selector.onSelect = value => {
			this.picker.setSelector(null)
			this.tui.setFocus(this.editor)
			onResult?.(value)
		}
		selector.onCancel = () => {
			this.picker.setSelector(null)
			this.tui.setFocus(this.editor)
			onResult?.(null)
		}
		this.picker.setSelector(selector)
		this.tui.setFocus(selector)
		return selector
	}

	/** Register extra input listeners (e.g. the application's key translation). */
	addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined): void {
		this.tui.addInputListener(listener)
	}

	start(): this {
		if (this.started) return this
		this.started = true
		this.tui.start()
		// Establish the layout frame (and therefore the primary scroll view)
		// before any key is dispatched; the viewport resolves its scroll target
		// from the most recent frame.
		this.tui.renderNow(true)
		return this
	}

	/** Deliver raw terminal bytes through the real input dispatch. */
	feed(data: string): void {
		this.send?.(data)
	}

	resize(width: number, height: number): void {
		this.columnsValue = width
		this.rowsValue = height
	}

	/** Force a full render and return the screen rows. */
	screen(): string[] {
		this.writes.length = 0
		this.tui.renderNow(true)
		return parseScreen(this.writes.join(""), this.rowsValue)
	}

	/** Force a full render and return the emitted rows with ANSI preserved. */
	rawScreen(): string[] {
		this.writes.length = 0
		this.tui.renderNow(true)
		return parseRawScreen(this.writes.join(""), this.rowsValue)
	}

	/** Conversation viewport state, for assertions. */
	get scrollTop(): number {
		return this.scroll.scrollTop
	}

	get viewportHeight(): number {
		return this.scroll.viewportHeight
	}

	get following(): boolean {
		return this.scroll.isFollowingEnd
	}
}
