import {
	Box,
	Container,
	Editor,
	Loader,
	Markdown,
	Text,
	TuiMainScreen,
	ProcessTerminal,
	matchesKey,
	type Component,
} from "@minicode/tui"
import type { Session } from "../session/session"
import type { RunEvent, SessionMessage } from "../session/types"
import type { MiniCode } from "../minicode"
import { ansi, markdownTheme } from "./theme"
import {
	ToolExecutionComponent,
	assistantMessage,
	errorNotice,
	notice,
	replayMessage,
	userMessage,
} from "./components"

export interface MiniCodeTuiOptions {
	agent: MiniCode
	session: Session
	/** Window title / header label (typically the workspace path). */
	label?: string
}

/**
 * The MiniCode main-screen TUI, reproducing Pi's interactive-mode behavior
 * (chat history ↑, working spinner, input editor, status footer). The
 * runtime is the source of truth: `RunEvent`s map 1:1 onto component
 * updates and the editor submits through the existing `MiniCode.run()`.
 *
 * Keys: Enter submits; Shift+Enter/Ctrl+J newline (Editor);
 * Esc interrupts a running task; Ctrl-C clears, twice within 500ms exits;
 * Ctrl-D exits on an empty editor; Ctrl-O toggles full tool output.
 */
export class MiniCodeTui {
	private readonly tui: TuiMainScreen
	private readonly chat = new Container()
	private readonly status = new Container()
	private readonly editor: Editor
	private readonly footer = new Text("", 1, 0)

	private readonly loader: Loader
	private running = false
	private iteration = 0
	private lastUsage: { input?: number; output?: number } | undefined
	private abort: AbortController | null = null
	private lastCtrlC = 0
	private toolsExpanded = false
	private modelContextWindow: number | undefined
	private gitBranch: string | undefined
	/** Follow-up tasks typed while a run is active (Pi's queue behavior). */
	private readonly followUps: string[] = []
	private readonly pendingTools = new Map<string, ToolExecutionComponent>()
	/** Container holding the in-flight streaming markdown, if any. */
	private streaming: Container | null = null
	private streamingText = ""

	constructor(private readonly options: MiniCodeTuiOptions) {
		this.tui = new TuiMainScreen(new ProcessTerminal())

		const hints = ansi.gray(
			"enter submit · shift+enter newline · esc interrupt · ctrl+c clear (twice exits) · ctrl+d exit · ctrl+o expand tools",
		)
		const header = new Container()
		header.addChild(new Text(`${ansi.bold(ansi.cyan("MiniCode"))} ${ansi.gray(options.label ?? options.session.cwd)}`, 1, 0))
		header.addChild(new Text(`  ${hints}`, 0, 0))

		this.tui.addChild(header)
		this.tui.addChild(this.chat)
		this.tui.addChild(this.status)
		this.editor = this.createEditor()
		this.tui.addChild(this.editor)
		this.tui.addChild(this.footer)

		this.loader = new Loader(this.tui, ansi.cyan, (text) => ansi.bold(text), "working… (esc to interrupt)")
		this.tui.addInputListener(data => this.handleGlobalInput(data))

		this.replaySession()
		void this.refreshFooterData()
		this.updateFooter()
	}

	private createEditor(): Editor {
		const editor = new Editor(this.tui, {
			borderColor: (text) => ansi.gray(text),
			selectList: {
				selectedPrefix: (text) => ansi.green(text),
				selectedText: (text) => ansi.bold(text),
				description: (text) => ansi.gray(text),
				scrollInfo: (text) => ansi.gray(text),
				noMatch: (text) => ansi.red(text),
			},
		})
		editor.onSubmit = (text: string) => {
			void this.submit(text)
		}
		return editor
	}

	// ── global keys ───────────────────────────────────

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (matchesKey(data, "escape")) {
			if (this.running) {
				this.abortRun()
				return { consume: true }
			}
			return undefined
		}
		if (matchesKey(data, "ctrl+c")) {
			if (this.running) {
				// Mirrors Pi's app.clear: clear input; the interrupt key is Esc.
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
		return undefined
	}

	private shutdown(): never {
		this.abort?.abort()
		this.tui.stop()
		process.exit(0)
	}

	// ── submission + follow-up queue ─────────────────────────────────

	private async submit(text: string): Promise<void> {
		const task = text.trim()
		if (task.length === 0) return
		if (this.running) {
			// Pi queues follow-ups; they run after the current task and are
			// restored into the editor if the run is aborted.
			this.followUps.push(task)
			this.chat.addChild(notice(`queued (${this.followUps.length}) — runs after the current task`))
			this.tui.requestRender()
			return
		}

		this.chat.addChild(userMessage(task))
		this.running = true
		this.iteration = 0
		this.abort = new AbortController()
		this.showSpinner("working… (esc to interrupt)")

		let aborted = false
		try {
			const result = await this.options.agent.run(this.options.session, task, {
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

		// Abort restores queued follow-ups to the editor (Pi behavior);
		// otherwise the next queued task runs.
		if (aborted && this.followUps.length > 0) {
			const restored = this.followUps.splice(0)
			this.editor.setText(restored.join("\n\n"))
			this.chat.addChild(notice("queued messages restored to the editor"))
			this.tui.requestRender()
			return
		}
		if (this.followUps.length > 0 && !aborted) {
			const next = this.followUps.shift()!
			await this.submit(next)
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
		switch (event.type) {
			case "run_start":
				break
			case "iteration_start":
				this.iteration = event.iteration
				this.loader.setMessage(`iteration ${event.iteration}… (esc to interrupt)`)
				this.updateFooter()
				break
			case "assistant_delta": {
				// Streaming markdown: recreate the markdown component per delta
				// (assistant texts are small; replaced by the final render below).
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
			case "model_response": {
				if (event.usage !== undefined) {
					this.lastUsage = { input: event.usage.inputTokens, output: event.usage.outputTokens }
				}
				// Finalize the streaming block with the definitive message.
				const last = this.options.session.lastAssistant()
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
			case "tool_result": {
				const component = this.pendingTools.get(event.toolCallId)
				if (component !== undefined) {
					component.setResult(event.ok, event.result)
					component.setExpanded(this.toolsExpanded)
					this.pendingTools.delete(event.toolCallId)
				}
				break
			}
			case "compaction":
				this.chat.addChild(notice(`context compacted — ${event.summarizedMessages} messages summarized`))
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
				if (event.error !== undefined) {
					this.chat.addChild(errorNotice(event.error))
				} else if (event.finishReason !== "stop" && event.finishReason !== "aborted") {
					this.chat.addChild(notice(`run ended without a final answer (${event.finishReason})`))
				}
				if (event.usage?.inputTokens !== undefined || event.usage?.outputTokens !== undefined) {
					this.lastUsage = { input: event.usage.inputTokens, output: event.usage.outputTokens }
				}
				this.iteration = 0
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
		const cwdShort = this.options.session.cwd.replace(/^\/home\/[^/]+/, "~").replace(/\/+$/, "") || "/"
		const branch = this.gitBranch !== undefined ? ` (${this.gitBranch})` : ""
		const parts = [
			ansi.gray(`${cwdShort}${branch}`),
		]
		if (this.lastUsage?.input !== undefined) {
			parts.push(ansi.gray(`↑${this.lastUsage.input} ↓${this.lastUsage.output ?? 0}`))
		}
		if (this.lastUsage?.input !== undefined && this.modelContextWindow !== undefined) {
			const percent = ((this.lastUsage.input / this.modelContextWindow) * 100).toFixed(1)
			parts.push(ansi.gray(`ctx ${percent}%`))
		}
		parts.push(
			this.running
				? ansi.yellow(`working (iteration ${this.iteration}) — esc to interrupt`)
				: ansi.green("idle"),
		)
		this.footer.setText(parts.join(ansi.gray("  ·  ")))
		this.tui.requestRender()
	}

	/** Loads boot-time footer data: model context window and git branch. */
	private async refreshFooterData(): Promise<void> {
		const model = await this.options.agent.currentModel()
		if (model !== undefined) {
			this.modelContextWindow = model.limits.contextWindow
		}
		try {
			const proc = Bun.spawnSync(["git", "-C", this.options.session.cwd, "rev-parse", "--abbrev-ref", "HEAD"])
			if (proc.exitCode === 0) {
				this.gitBranch = proc.stdout.toString().trim() || undefined
			}
		} catch {
			// Not a git repository — footer omits the branch.
		}
		this.updateFooter()
	}

	// ── session replay ───────────────────────────────────────────────

	/** Renders persisted history so a loaded session shows its conversation. */
	private replaySession(): void {
		const resultsByCallId = new Map<string, { ok: boolean; result: string }>()
		for (const message of this.options.session.messages) {
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
		for (const message of this.options.session.messages) {
			for (const component of replayMessage(message, resultsByCallId)) {
				this.chat.addChild(component)
			}
		}
		if (this.options.session.needsRecovery()) {
			this.chat.addChild(notice("interrupted run detected — it will be reconciled on the next task"))
		}
	}

	/** Renders a message appended to the session outside of a run. */
	addMessage(message: SessionMessage): void {
		for (const component of replayMessage(message, new Map())) {
			this.chat.addChild(component)
		}
		this.tui.requestRender()
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
