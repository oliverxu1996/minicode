import {
	Container,
	Editor,
	Loader,
	Markdown,
	Text,
	TuiAltScreen,
	ProcessTerminal,
	matchesKey,
	type Component,
} from "@minicode/tui"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ModelLimits } from "@minicode/model"
import type { MiniCode, RunEvent, Session, SessionMessage, Skill } from "@minicode/agent"
import { configDir, isProjectTrusted, loadResources, loadSettings } from "@minicode/agent"
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
import { buildTuiLayout } from "./view/layout"
import { runCompaction } from "./compaction"
import { Selector, PickerSlot, pickerVisibleItems, type SelectorItem } from "./view/selector"
import { MiniCodeAutocomplete } from "./input/autocomplete"
import { argumentPlaceholderFor } from "./input/argument-placeholder"
import { altEnterAsNewline } from "./input/alt-enter"
import { expandFileReferences } from "./input/expand"
import { COMMANDS, findCommand, type CommandContext, type CompactResult } from "./commands"
import {
	ToolExecutionComponent,
	assistantMessage,
	errorNotice,
	notice,
	replayMessage,
	userMessage,
} from "./view/components"



export interface MiniCodeTuiOptions {
	agent: MiniCode
	session: Session
	/** Window title / header label (typically the workspace path). */
	label?: string
}

interface AskState {
	label: string
	resolve: (value: string | null) => void
}

/**
 * The MiniCode fullscreen TUI.
 * The runtime is the source of truth: `RunEvent`s map 1:1 onto component
 * updates and the editor submits through the existing `MiniCode.run()`.
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
export class MiniCodeTui {
	private readonly tui: TuiAltScreen
	private readonly chat = new Container()
	private readonly status = new Container()
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
	private askState: AskState | null = null
	private promptTemplates: Array<{ name: string; description: string }> = []
	private reasoning: Container | null = null
	private readonly commandContext: CommandContext

	constructor(private readonly options: MiniCodeTuiOptions) {
		// A fullscreen viewport owns the screen: the conversation scrolls in-app
		// while the composer/status/footer stay pinned to the bottom.
		this.tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true })
		this.session = options.session

		const hints = ansi.gray(
			"enter submit · alt+enter newline · esc interrupt · ctrl+c clear (twice exits) · ctrl+d exit · ctrl+o tools · ctrl+p model · pageup/pagedown scroll · /help commands",
		)
		const header = new Container()
		header.addChild(new Text(`${ansi.bold(ansi.cyan("MiniCode"))} ${ansi.gray(options.label ?? this.session.cwd)}`, 1, 0))
		header.addChild(new Text(`  ${hints}`, 0, 0))

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
			picker: this.picker,
			editor: this.editor,
			footerRow1: this.footerRow1,
			footerRow2: this.footerRow2,
		})
		this.tui.setLayoutRoot(layout.root)

		this.loader = new Loader(this.tui, ansi.cyan, (text) => ansi.bold(text), "working… (esc to interrupt)")
		this.tui.addInputListener(data => this.handleGlobalInput(data))

		this.commandContext = this.buildCommandContext()
		this.refreshTemplates()
		this.replaySession()
		void this.refreshFooterData()
		this.updateFooter()
	}

	private buildCommandContext(): CommandContext {
		return {
			agent: () => this.options.agent,
			session: () => this.session,
			setSession: session => {
				this.session = session
				this.chat.clear()
				this.pendingTools.clear()
				this.replaySession()
				this.refreshTemplates()
				// A resumed/forked session may live in another workspace, so the
				// footer's branch (and model) are re-read, not carried over.
				void this.refreshFooterData()
				this.tui.requestRender()
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
					this.status.addChild(new Text(ansi.bold(label), 1, 0))
					this.tui.setFocus(this.editor)
					this.tui.requestRender()
				})
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
				const { Compactor } = await import("@minicode/agent")
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
			skills: (): Skill[] => this.currentSkills,
			reloadResources: (): void => this.refreshTemplates(),
			quit: (): void => this.shutdown(),
		}
	}

	private currentSkills: Skill[] = []

	private refreshTemplates(): void {
		const trusted = isProjectTrusted(this.session.cwd)
		const resources = loadResources(this.session.cwd, trusted)
		this.promptTemplates = resources.prompts.map(prompt => ({
			name: prompt.name,
			description: `template · ${prompt.source}`,
		}))
		this.currentSkills = resources.skills
	}

	// ── editor ───────────────────────────────────────────────────────

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
		editor.setAutocompleteProvider(new MiniCodeAutocomplete(
			() => [
				...COMMANDS.map(c => ({ name: c.name, description: c.description })),
				...this.promptTemplates.map(t => ({ name: t.name, description: t.description })),
			],
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
		// An open selector owns the keyboard.
		if (this.selector !== null) return undefined

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

			const command = findCommand(name)
			if (command !== undefined) {
				try {
					await command.execute(this.commandContext, args)
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
			// Prompt templates: /name expands to the template content.
			const template = this.promptTemplates.find(t => t.name === name)
			if (template !== undefined) {
				const content = this.readTemplate(name)
				if (content !== null) {
					await this.submit(content)
				}
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

	private readTemplate(name: string): string | null {
		const userDir = join(configDir(), "prompts")
		for (const dir of [join(this.session.cwd, ".minicode", "prompts"), userDir]) {
			try {
				return readFileSync(join(dir, `${name}.md`), "utf-8")
			} catch {
				// Try the next location.
			}
		}
		return null
	}

	private async startRun(text: string): Promise<void> {
		this.running = true
		this.display = NO_RUN_DISPLAY
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
		})
		this.footerRow1.setRow(lines.row1)
		this.footerRow2.setRow(lines.row2)
		this.tui.requestRender()
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
