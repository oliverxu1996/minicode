import {
	Container,
	Editor,
	Loader,
	Markdown,
	Text,
	TuiAltScreen,
	ProcessTerminal,
	type Terminal,
	matchesKey,
	type Component,
} from "@loongcode/tui"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ModelLimits, ModelMessage } from "@loongcode/model"
import type { Checkpoint, LoongCode, RewindNote, RunEvent, Session, SessionMessage } from "@loongcode/agent"
import { CheckpointStore } from "@loongcode/agent"
import { discardTurns, liveCheckpoints, recordRewind, rewindSession, summarizeRange, turnIndexOf, type CheckpointAdvance } from "@loongcode/agent"
import { configDir, listPromptTemplates, loadSettings } from "@loongcode/agent"
import { ansi, markdownTheme } from "./view/theme"
import {
	NO_RUN_DISPLAY,
	compactionNoticeText,
	footerRows,
	reduceRunDisplay,
	runSummaryLines,
	type RunDisplay,
} from "../projection"
import { FooterLineView } from "./view/footer"
import { KEYBOARD_HINTS, helloHeader } from "./view/banner"
import { buildTuiLayout, fixedChromeRows } from "./view/layout"
import { runCompaction } from "./compaction"
import { Selector, PickerSlot, pickerVisibleItems, type SelectorItem } from "./view/selector"
import { SessionManager, type SessionManagerAction } from "./view/session-manager"
import { workspaceSessions, type ScopedSessionSummary } from "./session/scope"
import { cloneSession, forkCandidates, forkSession } from "./session/operations"
import { LoongCodeAutocomplete } from "./input/autocomplete"
import { argumentPlaceholderFor } from "./input/argument-placeholder"
import { altEnterAsNewline } from "./input/alt-enter"
import { expandFileReferences } from "./input/expand"
import { COMMANDS, findCommand, type Command, type CommandContext, type CompactResult } from "./commands"
import {
	ToolExecutionComponent,
	assistantMessage,
	errorNotice,
	notice,
	replayMessage,
	userMessage,
} from "./view/components"

export interface LoongCodeTuiOptions {
	agent: LoongCode
	session: Session
	/** Window title / header label (typically the workspace path). */
	label?: string
	/**
	 * Terminal to render onto. Defaults to the process terminal; tests supply a
	 * mock so the real application can be driven without a PTY.
	 */
	terminal?: Terminal
}

/**
 * How a slash input resolves after the leading `/`. Registered commands take
 * precedence over prompt templates of the same name.
 */
export type SlashInput =
	| { kind: "command"; command: Command }
	| { kind: "template"; content: string }
	| { kind: "unknown" }

/**
 * Reads a prompt template's content from disk. Project templates take
 * precedence over user templates, matching the historical behavior. Content is
 * always read fresh, so edits apply on the next invocation.
 */
function readPromptTemplate(cwd: string, name: string): string | null {
	const userDir = join(configDir(), "prompts")
	for (const dir of [join(cwd, ".loongcode", "prompts"), userDir]) {
		try {
			return readFileSync(join(dir, `${name}.md`), "utf-8")
		} catch {
			// Try the next location.
		}
	}
	return null
}

/**
 * Resolves a slash input to the command or prompt template it names. Templates
 * are discovered live from disk, so a newly added one works without any
 * refresh command; a removed one stops resolving.
 */
export function resolveSlashInput(cwd: string, name: string): SlashInput {
	const command = findCommand(name)
	if (command !== undefined) return { kind: "command", command }
	const content = readPromptTemplate(cwd, name)
	if (content !== null) return { kind: "template", content }
	return { kind: "unknown" }
}

/**
 * The editor's autocomplete source: registered commands plus prompt templates
 * discovered live from disk, so added/removed templates appear (and disappear)
 * without a manual refresh.
 */
export function autocompleteItems(cwd: string): Array<{ name: string; description: string }> {
	return [
		...COMMANDS.map(c => ({ name: c.name, description: c.description })),
		...listPromptTemplates(cwd).map(t => ({ name: t.name, description: `template · ${t.source}` })),
	]
}

interface AskState {
	label: string
	resolve: (value: string | null) => void
}

/**
 * The LoongCode fullscreen TUI.
 * The runtime is the source of truth: `RunEvent`s map 1:1 onto component
 * updates and the editor submits through the existing `LoongCode.run()`.
 *
 * The conversation lives in an application-owned `ScrollView` (the only
 * scrolling region); the status, composer, and two footer rows are fixed to the
 * bottom. The header is the first item of the scroll content, so it scrolls away.
 *
 * Keys: Enter submits — and steers while a task runs; Alt+Enter inserts a
 * newline; Esc interrupts; Ctrl-C clears (twice exits); Ctrl-D exits empty;
 * Ctrl-O toggles tool output; Ctrl-P cycles models; PageUp/PageDown/Home/End and
 * the mouse wheel scroll the conversation.
 */
/** A one-line rendering of a restore outcome, spelling out every refusal. */
function describeFiles(outcome: { restored: readonly string[]; removed: readonly string[]; failed: readonly { path: string; reason: string }[]; skipped: readonly { path: string; reason: string }[] } | null): string {
	if (outcome === null) return "files unchanged"
	const parts: string[] = []
	if (outcome.restored.length > 0) parts.push(`restored ${outcome.restored.length} file(s)`)
	if (outcome.removed.length > 0) parts.push(`removed ${outcome.removed.length} file(s) the agent created`)
	if (outcome.skipped.length > 0) parts.push(`skipped ${outcome.skipped.length}: ${outcome.skipped.map(f => `${f.path} (${f.reason})`).join(", ")}`)
	if (outcome.failed.length > 0) parts.push(`could not restore ${outcome.failed.length}: ${outcome.failed.map(f => `${f.path} (${f.reason})`).join(", ")}`)
	// A turn that touched no file has nothing to restore and nothing to
	// disclaim: the tracking note belongs with a result it qualifies, not on
	// its own where it reads as an unexplained caveat.
	if (parts.length === 0) return "files unchanged"
	parts.push("note: only files the agent edited through its own tools are tracked; shell commands are not")
	return parts.join(" · ")
}

/** `3 messages`, `1 message` — the codebase's plural convention. */
function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`
}

/**
 * The session's standing warning, in one line.
 *
 * It states what is known — commands ran and were not reversed — and never
 * what they did, which nothing here can determine.
 */
function shellWarningText(note: RewindNote): string {
	const commands = plural(note.shellCommands, "shell command", "shell commands")
	const turns = plural(note.shellTurns, "rewound turn", "rewound turns")
	return `⚠ ${commands} in ${turns} not undone — effects may extend beyond this workspace`
}

/**
 * What a rewind's discarded turns ran that it cannot undo.
 *
 * Printed in the transcript beside the file results, so the three distinct
 * facts — conversation, tracked files, shell — are each stated once.
 */
function describeShell(discarded: readonly Checkpoint[]): string {
	const shellTurns = discarded.filter(c => (c.shell ?? 0) > 0)
	const commands = shellTurns.reduce((total, c) => total + (c.shell ?? 0), 0)
	if (shellTurns.length === 0) {
		// An unrecorded count is not a zero: a turn whose invocations were never
		// recorded cannot be reported as having run none.
		return discarded.some(c => c.shell === undefined)
			? "shell: not recorded for these turns — whether a command ran, and what it did, is unknown"
			: "shell: none invoked by the discarded turns"
	}
	return `shell: NOT reversed — ${plural(commands, "command", "commands")} ran in ${plural(shellTurns.length, "discarded turn", "discarded turns")}; they may have written files, left processes running, or changed state outside this workspace`
}

/**
 * The footer's run figures for a session with no run live in this process.
 *
 * The last run's record is read back from disk so a reloaded or switched-to
 * session describes its own history instead of claiming nothing ever ran. The
 * context reading is deliberately absent: it is never persisted, and no figure
 * is reconstructed from retained messages, which cannot reproduce what a
 * provider actually billed.
 */
function seededDisplay(session: Session): RunDisplay {
	const lastRun = session.runs.at(-1)
	if (lastRun === undefined) return NO_RUN_DISPLAY
	return {
		lastCallUsage: undefined,
		runUsage: lastRun.usage,
		runRequests: lastRun.modelCalls ?? 0,
		lastRun,
		compactedMessages: undefined,
	}
}

/** A checkpoint's prompt, short enough for a selector row. */
function truncateForRow(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim()
	return flat.length <= 72 ? flat : `${flat.slice(0, 71)}…`
}

export class LoongCodeTui {
	private readonly tui: TuiAltScreen
	private readonly chat = new Container()
	/** File checkpoints for `/rewind`, stored beside the session. */
	private readonly checkpointStore: CheckpointStore
	private readonly status = new Container()
	/**
	 * The persistent session warning row, above the picker. It renders zero
	 * rows while the session has nothing to warn about, and holds its row for
	 * as long as it does — the state it reports outlives the message that
	 * announced it.
	 */
	private readonly warning = new Container()
	private readonly editor: Editor
	private readonly footerRow1 = new FooterLineView()
	private readonly footerRow2 = new FooterLineView()
	/** Bottom-attached transient picker, rendered directly above the composer. */
	private readonly picker: PickerSlot

	private readonly loader: Loader
	private session: Session
	private running = false
	/**
	 * True for exactly the lifetime of a manual `/compact`. Application-owned:
	 * the compaction has no runtime event, so this transient drives both the
	 * footer ("Compacting", not "Idle") and the spinner.
	 */
	private compacting = false
	/** Runtime facts the footer reads, folded from the run's own events. */
	private display: RunDisplay = NO_RUN_DISPLAY
	/**
	 * The context reading was dropped by a rewind rather than never taken.
	 * Both leave the number unknown; only this says which.
	 */
	private contextCleared = false
	/** The displayed run's turns are no longer all in the conversation. */
	private runBeforeRewind = false
	private abort: AbortController | null = null
	private lastCtrlC = 0
	private toolsExpanded = false
	private modelId: string | undefined
	private modelLimits: ModelLimits | undefined
	private compactThresholdPct: number | undefined
	private gitBranch: string | undefined
	private readonly pendingTools = new Map<string, ToolExecutionComponent>()
	private streaming: Container | null = null
	private streamingText = ""
	private selector: Selector | null = null
	/** The open `/session` manager, which owns input while present. */
	private manager: SessionManager | null = null
	private askState: AskState | null = null
	private reasoning: Container | null = null
	private readonly commandContext: CommandContext

	constructor(private readonly options: LoongCodeTuiOptions) {
		this.checkpointStore = new CheckpointStore(options.agent.sessionsDir)
		// A fullscreen viewport owns the screen: the conversation scrolls in-app
		// while the composer/status/footer stay pinned to the bottom.
		this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), false, undefined, { mouse: true })
		this.session = options.session

		// The header is the transcript's true empty state: the hello banner is
		// rendered only while the session holds no conversation messages. Once
		// the first message exists the hero contributes zero rows, so the user's
		// message — not the banner — is the first transcript item, and the banner
		// can never be reached again through scrollback. `/new` and a switch to an
		// empty session satisfy the same predicate, so the hero returns without
		// any dedicated lifecycle flag. The live predicate reads the current
		// session (never a captured one) and the synchronous `running` flag, which
		// is already set when a submission begins, closing the window between
		// appending the user's message and the session recording it. The hero is
		// centered as a group inside the transcript viewport, measured live from
		// the fixed bottom chrome; it never blocks the composer.
		const header = helloHeader({
			label: options.label ?? this.session.cwd,
			hints: KEYBOARD_HINTS,
			availableHeight: () => this.transcriptViewportHeight(),
			visible: () => this.session.messages.length === 0 && !this.running,
		})

		this.editor = this.createEditor()
		// The picker is a fixed VStack entry directly above the composer; it
		// renders zero rows until a selector is opened, and caps its own height
		// from the live terminal size so it can never push the composer or
		// footer off-screen.
		this.picker = new PickerSlot(() => pickerVisibleItems(this.tui.terminal.rows))
		const layout = buildTuiLayout({
			header,
			chat: this.chat,
			status: this.status,
			warning: this.warning,
			picker: this.picker,
			editor: this.editor,
			footerRow1: this.footerRow1,
			footerRow2: this.footerRow2,
		})
		this.tui.setLayoutRoot(layout.root)

		this.loader = new Loader(this.tui, ansi.cyan, (text) => ansi.bold(text), "working… (esc to interrupt)")
		this.tui.addInputListener(data => this.handleGlobalInput(data))

		this.commandContext = this.buildCommandContext()
		this.replaySession()
		this.updateWarning()
		// The footer describes the session that is open, including the runs it
		// recorded in an earlier process; nothing here is invented to fill a
		// gap the persisted record does not cover.
		this.display = seededDisplay(this.session)
		void this.refreshFooterData()
		this.updateFooter()
	}

	/**
	 * The live transcript viewport height: the terminal minus every fixed bottom
	 * region (status, picker, composer, and the two footer rows). It is measured
	 * from the real components — not assumed to be a constant — so a multiline
	 * composer, an open picker, or a status row shrinks the area the centered
	 * hero is centered in, rather than letting the hero overlap the chrome.
	 */
	private transcriptViewportHeight(): number {
		const chromeRows = fixedChromeRows(
			[this.status, this.warning, this.picker, this.editor, this.footerRow1, this.footerRow2],
			this.tui.terminal.columns,
		)
		return Math.max(0, this.tui.terminal.rows - chromeRows)
	}

	private buildCommandContext(): CommandContext {
		return {
			agent: () => this.options.agent,
			session: () => this.session,
			setSession: session => {
				this.setActiveSession(session)
			},
			notify: (text, isError) => {
				this.chat.addChild(isError === true ? errorNotice(text) : notice(text))
				this.tui.requestRender()
			},
			pick: async (title, items, options) => {
				const selector = new Selector(
					title,
					items as SelectorItem[],
					options?.selectedValue,
				)
				return new Promise<string | null>(resolve => {
					// The selector fills the bottom-attached picker slot so it owns
					// input while open: viewport keys are deferred to the focused
					// selector, and closing restores the composer's focus.
					const close = (): void => {
						if (this.selector !== selector) return
						this.selector = null
						this.picker.setSelector(null)
						this.tui.setFocus(this.editor)
						this.tui.requestRender()
					}
					selector.onSelect = value => {
						close()
						resolve(value)
					}
					selector.onCancel = () => {
						close()
						resolve(null)
					}
					this.selector = selector
					this.picker.setSelector(selector)
					this.tui.setFocus(selector)
					this.tui.requestRender()
				})
			},
			ask: async (label, options) => {
				const secret = options?.secret === true
				return new Promise<string | null>(resolve => {
					this.askState = { label, resolve: value => {
						this.status.clear()
						this.editor.setMasked(false)
						this.tui.setFocus(this.editor)
						resolve(value)
					} }
					// Secret prompts mask the composer so the typed value is never
					// echoed; every resolution path (submit or Escape) clears it.
					this.editor.setMasked(secret)
					// A rename is seeded with the current title so the user edits
					// rather than retypes it; other prompts start empty.
					this.editor.setText(options?.initialValue ?? "")
					this.status.addChild(new Text(ansi.bold(label), 1, 0))
					this.tui.setFocus(this.editor)
					this.tui.requestRender()
				})
			},
			manageSessions: async (): Promise<void> => {
				await this.runSessionManager()
			},
			rewind: async (): Promise<void> => {
				await this.runRewind()
			},
			compact: async (): Promise<CompactResult> => {
				// A manual compaction must not run concurrently with another
				// compaction or an active run: both mutate the same durable history,
				// and the run owns the shared spinner. Refuse rather than start a
				// second mutator; the in-flight owner keeps its transient state.
				const busy: "compacting" | "running" | undefined =
					this.compacting ? "compacting" : this.running ? "running" : undefined
				if (busy !== undefined) return { status: "busy", reason: busy }
				const model = await this.options.agent.currentModel()
				if (model === undefined) return { status: "no-model" }
				const { Compactor } = await import("@loongcode/agent")
				const compactor = new Compactor(model, model.limits.contextWindow)
				// `runCompaction` brackets the awaited model call; its `finally`
				// guarantees the state and spinner are cleared on success, failure,
				// or an unexpected throw.
				const outcome = await runCompaction(this.session, compactor, {
					begin: () => {
						this.compacting = true
						// No interrupt hint: Esc aborts a run, not a manual compaction.
						this.showSpinner("Compacting context…")
						this.updateFooter()
					},
					end: () => {
						this.compacting = false
						this.hideSpinner()
						this.updateFooter()
					},
				})
				if (outcome.status === "compacted") {
					this.chat.clear()
					this.replaySession()
					// Manual compaction is not a runtime event; record its message
					// count here so the footer reports it like an automatic one.
					this.display = { ...this.display, compactedMessages: outcome.removed }
					this.updateFooter()
					this.tui.requestRender()
				}
				return outcome
			},
			submitTask: async text => {
				await this.submit(text)
			},
			quit: (): void => this.shutdown(),
		}
	}

	// ── editor ───────────────────────────────────────────────────────

	/**
	 * Replaces the active session and replays it. Owns every UI refresh a
	 * switch requires: transcript, pending tool state, and the footer's
	 * workspace/model/branch.
	 */
	private setActiveSession(session: Session): void {
		this.session = session
		this.chat.clear()
		this.pendingTools.clear()
		this.replaySession()
		// Every session-owned reading is replaced, not carried over: another
		// session's run figures and warnings describe another conversation.
		this.display = seededDisplay(session)
		this.contextCleared = false
		this.runBeforeRewind = false
		this.updateWarning()
		// A switched/forked session may live in another workspace, so the
		// footer's branch (and model) are re-read, not carried over.
		void this.refreshFooterData()
		this.updateFooter()
		this.tui.requestRender()
	}

	private createEditor(): Editor {
		const editor = new Editor(
			this.tui,
			{
				borderColor: (text) => ansi.gray(text),
				selectList: {
					selectedPrefix: (text) => ansi.green(text),
					selectedText: (text) => ansi.bold(text),
					description: (text) => ansi.gray(text),
					scrollInfo: (text) => ansi.gray(text),
					noMatch: (text) => ansi.red(text),
				},
			},
			{ ghostTextStyle: (text) => ansi.gray(text) },
		)
		editor.setAutocompleteProvider(new LoongCodeAutocomplete(
			() => autocompleteItems(this.session.cwd),
			() => this.session.cwd,
		))
		editor.setGhostTextProvider(state => argumentPlaceholderFor(state, COMMANDS))
		editor.onSubmit = (text: string) => {
			void this.submit(text)
		}
		return editor
	}

	// ── global keys ───────────────────────────────────

	private handleGlobalInput(data: string): { consume?: boolean; data?: string } | undefined {
		// An open selector or session manager owns the keyboard.
		if (this.selector !== null || this.manager !== null) return undefined

		// Alt+Enter inserts a newline in the composer. The application used to
		// submit/queue here; it now rewrites the event so the editor's existing
		// newline path handles it uniformly across terminal encodings.
		const newline = altEnterAsNewline(data)
		if (newline !== undefined) return newline

		if (matchesKey(data, "escape")) {
			if (this.askState !== null) {
				const ask = this.askState
				this.askState = null
				this.status.clear()
				ask.resolve(null)
				this.tui.requestRender()
				return { consume: true }
			}
			if (this.running) {
				this.abortRun()
				return { consume: true }
			}
			return undefined
		}
		if (matchesKey(data, "ctrl+c")) {
			if (this.running) {
				this.editor.setText("")
				this.tui.requestRender()
				return { consume: true }
			}
			const now = Date.now()
			if (now - this.lastCtrlC < 500) {
				this.shutdown()
			} else {
				this.lastCtrlC = now
				this.editor.setText("")
				this.chat.addChild(notice("press ctrl-c again to exit"))
			}
			return { consume: true }
		}
		if (matchesKey(data, "ctrl+d")) {
			if (!this.running && this.editor.getText().trim().length === 0) {
				this.shutdown()
				return { consume: true }
			}
			return undefined
		}
		if (matchesKey(data, "ctrl+o")) {
			this.toolsExpanded = !this.toolsExpanded
			for (const component of this.chat.children) {
				if (component instanceof ToolExecutionComponent) component.setExpanded(this.toolsExpanded)
			}
			this.tui.requestRender()
			return { consume: true }
		}
		if (matchesKey(data, "ctrl+p")) {
			void this.cycleModel()
			return { consume: true }
		}
		return undefined
	}

	private async cycleModel(): Promise<void> {
		const manager = await this.options.agent.modelManager()
		const models = manager.list()
		if (models.length < 2) {
			this.chat.addChild(notice("only one model configured"))
			return
		}
		const currentId = (await this.options.agent.currentModel())?.id
		const index = models.findIndex(m => m.id === currentId)
		const next = models[(index + 1) % models.length]!
		this.options.agent.activateModel(next.id)
		this.chat.addChild(notice(`switched model: ${next.id}`))
		// The footer's model identity and window must follow the switch.
		await this.refreshFooterData()
		this.tui.requestRender()
	}

	private shutdown(): never {
		this.abort?.abort()
		this.tui.stop()
		process.exit(0)
	}

	// ── submission ───────────────────────────────────────────────────

	private async submit(raw: string): Promise<void> {
		if (this.askState !== null) {
			const ask = this.askState
			this.askState = null
			this.status.clear()
			ask.resolve(raw)
			return
		}

		const text = raw.trim()
		if (text.length === 0) return

		if (text.startsWith("/")) {
			const spaceIdx = text.indexOf(" ")
			const name = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)
			const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1)

			const input = resolveSlashInput(this.session.cwd, name)
			if (input.kind === "command") {
				try {
					await input.command.execute(this.commandContext, args)
				} catch (error) {
					// Model-management failures must surface as normal error
					// notices, never as an uncaught stack trace over the TUI.
					this.chat.addChild(errorNotice(
						`/${name} failed: ${error instanceof Error ? error.message : String(error)}`,
					))
				}
				// A command may change the active model (e.g. /model), so
				// the footer's model identity and window are re-read here.
				await this.refreshFooterData()
				this.tui.requestRender()
				return
			}
			// Prompt templates: /name expands to the template content, resolved
			// live from disk so added, edited, and removed templates apply
			// immediately.
			if (input.kind === "template") {
				await this.submit(input.content)
				return
			}
			this.chat.addChild(errorNotice(`unknown command "/${name}" — try /help`))
			this.tui.requestRender()
			return
		}

		if (this.running) {
			// Enter during a run steers the agent.
			this.session.steer(text)
			this.chat.addChild(notice("steering…"))
			this.tui.requestRender()
			return
		}

		if (this.compacting) {
			// A task must not start while a manual compaction is rewriting the
			// same history (and the compaction owns the shared spinner).
			this.chat.addChild(notice("a compaction is in progress — wait for it to finish"))
			this.tui.requestRender()
			return
		}

		this.chat.addChild(userMessage(text))
		await this.startRun(expandFileReferences(text, this.session.cwd))
	}

	private async startRun(text: string): Promise<void> {
		this.running = true
		this.display = NO_RUN_DISPLAY
		// The new run measures its own context and produces its own figures, so
		// the previous reading's provenance stops being reported.
		this.contextCleared = false
		this.runBeforeRewind = false
		this.abort = new AbortController()
		// The model is resolved per run, so the footer's budget is refreshed
		// here: a switch made by /model or Ctrl-P must not leave it stale.
		await this.refreshFooterData()
		this.showSpinner("working… (esc to interrupt)")

		let aborted = false
		try {
			const result = await this.options.agent.run(this.session, text, {
				signal: this.abort.signal,
				onEvent: event => this.handleRunEvent(event),
			})
			aborted = result.aborted
			if (aborted) this.chat.addChild(notice("run aborted"))
		} catch (err) {
			this.chat.addChild(errorNotice(err instanceof Error ? err.message : String(err)))
		} finally {
			this.running = false
			this.abort = null
			this.finalizeStreaming()
			this.hideSpinner()
			this.updateFooter()
			this.tui.setFocus(this.editor)
			this.tui.requestRender()
		}
	}

	private abortRun(): void {
		if (this.abort !== null) {
			this.abort.abort()
			this.tui.requestRender()
		}
	}

	// ── RunEvent → UI (the single event adapter) ─────────────────────

	private handleRunEvent(event: RunEvent): void {
		// The display facts are folded from the runtime's own events, once.
		this.display = reduceRunDisplay(this.display, event)
		switch (event.type) {
			case "run_start":
				break
			case "iteration_start":
				this.loader.setMessage("working… (esc to interrupt)")
				this.updateFooter()
				break
			case "assistant_delta": {
				if (this.streaming === null) {
					this.streaming = new Container()
					this.streamingText = ""
					this.chat.addChild(this.streaming)
				}
				this.streamingText += event.text
				this.streaming.clear()
				this.streaming.addChild(new Markdown(this.streamingText, 1, 0, markdownTheme()))
				break
			}
			case "reasoning_delta": {
				if (this.reasoning === null) {
					this.reasoning = new Container()
					this.chat.addChild(this.reasoning)
				}
				this.reasoning.clear()
				this.reasoning.addChild(new Text(`  ${ansi.gray("… thinking")}`, 0, 0))
				break
			}
			case "steered":
				this.chat.addChild(notice("steered"))
				break
			case "model_response": {
				const last = this.session.lastAssistant()
				const text = last !== undefined
					? last.content.filter(part => part.type === "text").map(part => part.text).join("")
					: ""
				if (this.streaming !== null) {
					this.streaming.clear()
					if (text.trim().length > 0) this.streaming.addChild(assistantMessage(text))
					this.streaming = null
				} else if (text.trim().length > 0) {
					this.chat.addChild(assistantMessage(text))
				}
				break
			}
			case "tool_call": {
				const component = new ToolExecutionComponent(event.toolCallId, event.name, event.input)
				this.pendingTools.set(event.toolCallId, component)
				this.chat.addChild(component)
				break
			}
			case "tool_progress": {
				const component = this.pendingTools.get(event.toolCallId)
				if (component !== undefined) {
					component.setProgress(event.text)
					this.tui.requestRender()
				}
				break
			}
			case "tool_result": {
				const component = this.pendingTools.get(event.toolCallId)
				if (component !== undefined) {
					// Duration is the runtime's; the TUI never times a tool itself.
					component.setResult(event.ok, event.result, event.durationMs)
					component.setExpanded(this.toolsExpanded)
					this.pendingTools.delete(event.toolCallId)
				}
				break
			}
			case "compaction":
				this.chat.addChild(notice(compactionNoticeText(event.summarizedMessages, event.usage)))
				break
			case "auto_retry":
				this.loader.setMessage(
					`provider busy — retrying (${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s… (esc to interrupt)`,
				)
				break
			case "recovery":
				this.chat.addChild(notice(event.note.split("\n")[0] ?? "recovered from interruption"))
				break
			case "run_end": {
				// The failure that ended the run, in full, before the summary.
				if (event.run.error !== undefined) this.chat.addChild(errorNotice(event.run.error))

				// The runtime's own record, rendered as sent — no value here is
				// recomputed, and the record itself states how the run ended. The
				// summary reports the authoritative model-call count; the footer's
				// live run figures reset when the next run starts.
				for (const line of runSummaryLines(event.run)) {
					this.chat.addChild(notice(line))
				}
				break
			}
		}
		this.updateFooter()
		this.tui.requestRender()
	}

	private finalizeStreaming(): void {
		if (this.streaming !== null) {
			this.streaming.clear()
			if (this.streamingText.trim().length > 0) {
				this.streaming.addChild(assistantMessage(this.streamingText))
			}
			this.streaming = null
			this.streamingText = ""
		}
	}

	// ── status / footer ──────────────────────────────────────────────

	private showSpinner(label: string): void {
		this.status.clear()
		this.loader.setMessage(label)
		this.status.addChild(this.loader)
		this.loader.start()
	}

	private hideSpinner(): void {
		this.loader.stop()
		this.status.clear()
	}

	private updateFooter(): void {
		const lines = footerRows({
			cwd: this.session.cwd,
			branch: this.gitBranch,
			running: this.running,
			compacting: this.compacting,
			modelId: this.modelId,
			limits: this.modelLimits,
			compactThresholdPct: this.compactThresholdPct,
			lastCallUsage: this.display.lastCallUsage,
			runRequests: this.display.runRequests,
			runUsage: this.display.runUsage,
			lastRun: this.display.lastRun,
			compactedMessages: this.display.compactedMessages,
			contextCleared: this.contextCleared,
			runBeforeRewind: this.runBeforeRewind,
		})
		this.footerRow1.setRow(lines.row1)
		this.footerRow2.setRow(lines.row2)
		this.tui.requestRender()
	}

	/**
	 * Re-renders the persistent warning row from the session's own state.
	 *
	 * Read from the session rather than from a flag set at rewind time, so a
	 * switch, a reload and a rewind all render the same fact the same way.
	 */
	private updateWarning(): void {
		this.warning.clear()
		const note = this.session.rewind
		if (note !== null && note.shellTurns > 0) {
			this.warning.addChild(new Text(`  ${ansi.yellow(shellWarningText(note))}`, 1, 0))
		}
	}

	private async refreshFooterData(): Promise<void> {
		// Re-read per run and on every model switch: the footer must describe
		// the model actually in use, never a previous one.
		const model = await this.options.agent.currentModel()
		this.modelId = model?.id
		this.modelLimits = model?.limits
		try {
			this.compactThresholdPct = loadSettings(this.session.cwd).settings.autoCompact?.thresholdPct
		} catch {
			// A malformed settings file must not break the footer. Without a
			// threshold the context segment omits it rather than guessing one.
			this.compactThresholdPct = undefined
		}
		try {
			const proc = Bun.spawnSync(["git", "-C", this.session.cwd, "rev-parse", "--abbrev-ref", "HEAD"])
			if (proc.exitCode === 0) {
				this.gitBranch = proc.stdout.toString().trim() || undefined
			}
		} catch {
			// Not a git repository — footer omits the branch.
		}
		this.updateFooter()
	}

	// ── session manager (/session) ───────────────────────────────────

	/** True while a run or a manual compaction owns the active session. */
	private sessionBusy(): boolean {
		return this.running || this.compacting
	}

	private notifySessionBusy(): void {
		this.chat.addChild(notice(this.running
			? "a task is running — finish it before managing sessions"
			: "a compaction is in progress — wait for it to finish"))
		this.tui.requestRender()
	}

	/**
	 * The workspace-scoped candidate set: persisted sessions whose `cwd` matches
	 * the active workspace. The active session is included even when it has not
	 * been persisted yet (a fresh session is only written on its first
	 * checkpoint), so it is always visible — without ever widening the boundary.
	 */
	private async scopedSessions(workspace: string): Promise<ScopedSessionSummary[]> {
		const summaries = await this.options.agent.sessionSummaries()
		const scoped: ScopedSessionSummary[] = workspaceSessions(summaries, workspace)
		if (!scoped.some(session => session.id === this.session.id) && this.session.cwd === workspace) {
			scoped.unshift(this.summaryOf(this.session))
		}
		return scoped
	}

	private summaryOf(session: Session): ScopedSessionSummary {
		const firstUser = session.messages.find(message => message.role === "user")
		return {
			id: session.id,
			cwd: session.cwd,
			cwdPresent: true,
			title: session.title,
			parentSessionId: session.parentSessionId,
			updatedAt: session.updatedAt,
			messageCount: session.messages.length,
			firstUser: firstUser !== undefined && typeof firstUser.content === "string" ? firstUser.content.slice(0, 60) : null,
		}
	}

	/** Loads a session only if it belongs to the scoped candidate set. */
	private async loadScopedSession(scoped: readonly ScopedSessionSummary[], id: string): Promise<Session | null> {
		if (!scoped.some(session => session.id === id)) return null
		if (id === this.session.id) return this.session
		try {
			return await this.options.agent.loadSession(id)
		} catch {
			return null
		}
	}

	private openSessionManager(sessions: readonly ScopedSessionSummary[]): Promise<SessionManagerAction> {
		const manager = new SessionManager(sessions, this.session.id, `Sessions · ${this.session.cwd}`)
		return new Promise<SessionManagerAction>(resolve => {
			const close = (action: SessionManagerAction): void => {
				if (this.manager !== manager) return
				this.manager = null
				this.picker.setComponent(null)
				this.tui.setFocus(this.editor)
				this.tui.requestRender()
				resolve(action)
			}
			manager.onAction = close
			this.manager = manager
			this.picker.setComponent(manager)
			this.tui.setFocus(manager)
			this.tui.requestRender()
		})
	}

	/**
	 * Drives `/session`: open the workspace-scoped manager, execute the chosen
	 * action, and reopen it after operations that stay within management. All
	 * session mutations and switches are guarded against an active run, both on
	 * open and again before each operation.
	 */
	/**
	 * `/rewind`: pick a checkpoint, pick an action, apply it.
	 *
	 * Nothing is restored by selecting a checkpoint — the action menu is a
	 * second, explicit step, and every destructive action is confirmed. A run
	 * in flight refuses the whole flow: rewinding history underneath a live run
	 * would leave it describing turns that no longer exist.
	 */
	private async runRewind(): Promise<void> {
		if (this.running) {
			this.notifyRewindRefused("a run is in progress — press esc to interrupt it first")
			return
		}
		if (this.compacting) {
			this.notifyRewindRefused("a compaction is in progress — wait for it to finish")
			return
		}

		const stored = await this.checkpointStore.load(this.session.id)
		// An index is not an identity: a rewind frees indices that the next turn
		// reuses, so a record is offered only while it still anchors to the turn
		// it was opened for.
		const usable = liveCheckpoints(stored, this.session.messages)
		if (usable.length === 0) {
			this.chat.addChild(notice(stored.length === 0
				? "nothing to rewind to yet — checkpoints are created per prompt"
				: "nothing to rewind to — earlier checkpoints no longer match this conversation"))
			this.tui.requestRender()
			return
		}

		const chosen = await this.commandContext.pick(
			"Rewind to",
			[...usable].reverse().map(checkpoint => ({
				value: checkpoint.id,
				label: truncateForRow(checkpoint.prompt),
				description: [
					// A turn that touched no file shows no count: "0 files"
					// names an absence as if it were a result, and most turns
					// are ordinary conversation.
					...(checkpoint.files.length > 0 ? [plural(checkpoint.files.length, "file", "files")] : []),
					// Only a positive count is a fact; an absent one predates
					// shell tracking and claims nothing either way.
					...(checkpoint.shell !== undefined && checkpoint.shell > 0
						? [plural(checkpoint.shell, "shell command", "shell commands")]
						: []),
					new Date(checkpoint.createdAt).toLocaleTimeString(),
				].join(" · "),
			})),
		)
		if (chosen === null) return
		const checkpoint = usable.find((c: Checkpoint) => c.id === chosen)
		if (checkpoint === undefined) return

		const action = await this.commandContext.pick("Rewind action", [
			{ value: "both", label: "Restore code and conversation", description: "undo the turn, files included" },
			{ value: "conversation", label: "Restore conversation", description: "keep the files as they are" },
			{ value: "code", label: "Restore code", description: "keep the conversation as it is" },
			{ value: "summary-from", label: "Summarize from here", description: "replace this turn onward with a summary" },
			{ value: "summary-up-to", label: "Summarize up to here", description: "replace everything before this turn" },
			{ value: "cancel", label: "Cancel", description: "change nothing" },
		])
		if (action === null || action === "cancel") return

		await this.applyRewind(checkpoint, action, stored)
	}

	/**
	 * Records that history changed underneath the footer's readings.
	 *
	 * The context gauge describes how full the *current* context is, and that
	 * reading was taken before the rewrite, so it is dropped rather than
	 * presented as current. Clearing only the reading — not `runRequests`,
	 * `runUsage` or `lastRun` — leaves the session's genuine execution history
	 * intact; the gauge returns with the next real measurement, and the run
	 * figures are relabelled rather than adjusted.
	 */
	private forgetStaleAfterRewrite(historyChanged: boolean): void {
		// A rewrite that changed nothing leaves the reading exactly as valid as
		// it was: claiming it went stale would be its own small lie.
		if (!historyChanged) return
		this.display = { ...this.display, lastCallUsage: undefined }
		this.contextCleared = true
		this.runBeforeRewind = true
	}

	/**
	 * Persists what a rewrite did to the checkpoint lineage, and what it
	 * discarded that cannot be undone.
	 *
	 * The tombstone write and the session's warning are one commit: a warning
	 * that outlived its tombstones (or the reverse) would describe a state that
	 * never existed.
	 */
	private async commitAdvance(advance: CheckpointAdvance): Promise<string | null> {
		// The conversation has already changed, so the in-memory record of it
		// changes with it. Only persistence can fail from here.
		recordRewind(this.session, advance.discarded)
		this.updateWarning()
		try {
			await this.checkpointStore.save(this.session.id, advance.next)
			await this.session.checkpoint()
			return null
		} catch (err) {
			// Reporting this as a failed rewind would be false — it happened.
			return `the change was applied, but its checkpoint record could not be saved (${err instanceof Error ? err.message : String(err)}) — later rewinds may still offer these turns`
		}
	}

	/** Applies one chosen rewind action and reports exactly what happened. */
	private async applyRewind(checkpoint: Checkpoint, action: string, stored: readonly Checkpoint[]): Promise<void> {
		try {
			if (action === "code") {
				// Files only: the conversation, and so every checkpoint and the
				// session's warning, are exactly as they were.
				const outcome = await rewindSession(this.session, checkpoint, "code")
				this.chat.addChild(notice(describeFiles(outcome.files)))
				this.tui.requestRender()
				return
			}

			// Where this checkpoint's turn begins NOW. Derived from the turn's
			// identity rather than the index stored with the checkpoint, which
			// a compaction or an earlier rewind may have invalidated.
			const boundary = turnIndexOf(this.session.messages, checkpoint.turnId)
			if (boundary < 0) {
				this.chat.addChild(errorNotice("rewind: that turn is no longer in this conversation"))
				this.tui.requestRender()
				return
			}
			// "Summarize up to here" replaces what is above the checkpoint;
			// everything else cuts from the checkpoint down.
			const from = action === "summary-up-to" ? 0 : boundary
			const to = action === "summary-up-to" ? boundary : this.session.messages.length

			if (action === "summary-from" || action === "summary-up-to") {
				await this.summarizeHistory(from, to, stored)
				return
			}

			const outcome = await rewindSession(this.session, checkpoint, action === "both" ? "both" : "conversation")
			const advance = discardTurns(stored, outcome.removedTurnIds)
			const unsaved = await this.commitAdvance(advance)
			this.forgetStaleAfterRewrite(outcome.removedMessages > 0)
			this.chat.clear()
			this.pendingTools.clear()
			this.replaySession()
			// The three facts, each stated once: what happened to the
			// conversation, to tracked files, and to everything a shell did.
			// With no discarded turn there is no shell fact to state: a turn
			// that ran a command always has a record now.
			this.chat.addChild(notice(describeFiles(outcome.files)))
			if (advance.discarded.length > 0) this.chat.addChild(notice(describeShell(advance.discarded)))
			this.restorePrompt(checkpoint.prompt)
			this.chat.addChild(notice(`rewound ${plural(outcome.removedMessages, "message", "messages")} — the prompt is back in the composer`))
			if (unsaved !== null) this.chat.addChild(errorNotice(unsaved))
			this.tui.requestRender()
		} catch (err) {
			this.chat.addChild(errorNotice(`rewind failed: ${err instanceof Error ? err.message : String(err)}`))
			this.tui.requestRender()
		}
	}

	/** Summarizes `[from, to)` and reports the result; the files are untouched. */
	private async summarizeHistory(from: number, to: number, stored: readonly Checkpoint[]): Promise<void> {
		const range = this.session.messages.slice(from, to)
		const text = await this.options.agent.summarize(
			range.map(m => ({ role: m.role, content: m.content }) as ModelMessage),
		)
		// `summarizeRange` re-checks the boundaries and refuses a range that
		// would split a turn, so a bad selection cannot corrupt the history.
		const outcome = await summarizeRange(this.session, from, to, async () => text)
		// The rewrite reports the turns it removed; those, and only those, are
		// what this operation discarded.
		const advance = discardTurns(stored, outcome.removedTurnIds)
		const unsaved = await this.commitAdvance(advance)
		this.forgetStaleAfterRewrite(outcome.replaced > 0)
		this.chat.clear()
		this.pendingTools.clear()
		this.replaySession()
		if (advance.discarded.length > 0) this.chat.addChild(notice(describeShell(advance.discarded)))
		this.chat.addChild(notice(`summarized ${plural(outcome.replaced, "message", "messages")}; files unchanged`))
		if (unsaved !== null) this.chat.addChild(errorNotice(unsaved))
		this.tui.requestRender()
	}

	private notifyRewindRefused(reason: string): void {
		this.chat.addChild(errorNotice(`cannot rewind: ${reason}`))
		this.tui.requestRender()
	}

	/** Puts a rewound prompt back in the composer so it can be edited and resent. */
	private restorePrompt(prompt: string): void {
		this.editor.setText(prompt)
	}

	private async runSessionManager(): Promise<void> {
		if (this.sessionBusy()) {
			this.notifySessionBusy()
			return
		}
		const workspace = this.session.cwd

		for (;;) {
			const scoped = await this.scopedSessions(workspace)
			const action = await this.openSessionManager(scoped)

			if (action.kind === "close") return
			// A run may have started while the manager was open; refuse rather
			// than race it. Management follows the same busy contract as /compact.
			if (this.sessionBusy()) {
				this.notifySessionBusy()
				return
			}

			switch (action.kind) {
				case "switch": {
					if (action.id === this.session.id) return
					const next = await this.loadScopedSession(scoped, action.id)
					if (next === null) {
						this.chat.addChild(errorNotice("that session is no longer available"))
						this.tui.requestRender()
						continue
					}
					this.setActiveSession(next)
					this.chat.addChild(notice(`switched to session ${next.id.slice(0, 8)}`))
					return
				}
				case "rename": {
					const target = await this.loadScopedSession(scoped, action.id)
					if (target === null) {
						this.chat.addChild(errorNotice("that session is no longer available"))
						this.tui.requestRender()
						continue
					}
					const input = await this.commandContext.ask("Rename session", { initialValue: target.title ?? "" })
					if (input === null) continue
					const title = input.trim()
					if (title.length === 0) {
						this.chat.addChild(errorNotice("session title cannot be empty"))
						this.tui.requestRender()
						continue
					}
					try {
						await target.setTitle(title)
						this.chat.addChild(notice(`session renamed: ${title}`))
					} catch (error) {
						this.chat.addChild(errorNotice(`rename failed: ${error instanceof Error ? error.message : String(error)}`))
					}
					this.tui.requestRender()
					continue
				}
				case "delete": {
					if (action.id === this.session.id) {
						this.chat.addChild(errorNotice("cannot delete the current session"))
						this.tui.requestRender()
						continue
					}
					// The boundary holds at the operation site, not just in the
					// component: only an id from the scoped set may be deleted.
					if (!scoped.some(session => session.id === action.id)) {
						this.chat.addChild(errorNotice("that session is no longer available"))
						this.tui.requestRender()
						continue
					}
					try {
						await this.options.agent.deleteSession(action.id)
					} catch (error) {
						this.chat.addChild(errorNotice(`delete failed: ${error instanceof Error ? error.message : String(error)}`))
						this.tui.requestRender()
						continue
					}
					// `SessionStore.delete` swallows errors, so a normal return is
					// not proof. Re-enumerate and treat a surviving id as failure.
					const remaining = await this.scopedSessions(workspace)
					if (remaining.some(session => session.id === action.id)) {
						this.chat.addChild(errorNotice("delete failed: the session is still present"))
						this.tui.requestRender()
						continue
					}
					this.chat.addChild(notice("session deleted"))
					this.tui.requestRender()
					continue
				}
				case "fork": {
					const parent = await this.loadScopedSession(scoped, action.id)
					if (parent === null) {
						this.chat.addChild(errorNotice("that session is no longer available"))
						this.tui.requestRender()
						continue
					}
					const candidates = forkCandidates(parent)
					if (candidates.length === 0) {
						this.chat.addChild(notice("nothing to fork yet"))
						this.tui.requestRender()
						continue
					}
					const chosen = await this.commandContext.pick(
						"Fork from message",
						candidates.map(candidate => ({
							value: String(candidate.index),
							label: candidate.label,
							description: candidate.description,
						})),
					)
					if (chosen === null) continue
					const cut = Number(chosen) + 1
					try {
						const forked = await forkSession(this.options.agent, parent, cut)
						this.setActiveSession(forked)
						this.chat.addChild(notice(`forked session ${forked.id.slice(0, 8)} from message #${cut}`))
					} catch (error) {
						this.chat.addChild(errorNotice(`fork failed: ${error instanceof Error ? error.message : String(error)}`))
						this.tui.requestRender()
						continue
					}
					return
				}
				case "clone": {
					const source = await this.loadScopedSession(scoped, action.id)
					if (source === null) {
						this.chat.addChild(errorNotice("that session is no longer available"))
						this.tui.requestRender()
						continue
					}
					try {
						const clone = await cloneSession(this.options.agent, source)
						this.setActiveSession(clone)
						this.chat.addChild(notice(`cloned into session ${clone.id.slice(0, 8)}`))
					} catch (error) {
						this.chat.addChild(errorNotice(`clone failed: ${error instanceof Error ? error.message : String(error)}`))
						this.tui.requestRender()
						continue
					}
					return
				}
			}
		}
	}

	// ── session replay ───────────────────────────────────────────────

	private replaySession(): void {
		const resultsByCallId = new Map<string, { ok: boolean; result: string }>()
		for (const message of this.session.messages) {
			if (message.role !== "tool") continue
			for (const result of message.content) {
				const text = result.output.type === "json"
					? JSON.stringify(result.output.value) ?? ""
					: result.output.text
				resultsByCallId.set(result.toolCallId, {
					ok: result.output.type !== "tool_error",
					result: text,
				})
			}
		}
		for (const message of this.session.messages) {
			for (const component of replayMessage(message, resultsByCallId)) {
				this.chat.addChild(component)
			}
		}
		if (this.session.needsRecovery()) {
			this.chat.addChild(notice("interrupted run detected — it will be reconciled on the next task"))
		}
	}

	// ── lifecycle ────────────────────────────────────────────────────

	start(): void {
		this.tui.start()
		this.tui.setFocus(this.editor)
		this.updateFooter()
	}

	stop(): void {
		this.tui.stop()
	}
}
