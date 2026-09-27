import {
	Container,
	Editor,
	Loader,
	Text,
	TuiMainScreen,
	ProcessTerminal,
	matchesKey,
	type Component,
} from "@minicode/tui"
import type { Session } from "../session/session"
import type { SessionMessage } from "../session/types"
import type { RunEvent } from "../session/types"
import type { MiniCode } from "../minicode"
import { ansi } from "./theme"
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
 * The MiniCode main-screen TUI, modeled on Pi's interactive mode
 * (chat history ↑, status spinner, input editor, footer). The runtime is
 * the source of truth: `RunEvent`s map 1:1 onto component updates and the
 * editor submits through the existing `MiniCode.run()`.
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
	private readonly pendingTools = new Map<string, ToolExecutionComponent>()

	constructor(private readonly options: MiniCodeTuiOptions) {
		this.tui = new TuiMainScreen(new ProcessTerminal())

		const header = new Text(
			`${ansi.bold(ansi.cyan("MiniCode"))} ${ansi.gray(options.label ?? options.session.cwd)}`,
			1,
			0,
		)
		this.tui.addChild(header)
		this.tui.addChild(this.chat)
		this.tui.addChild(this.status)
		this.editor = this.createEditor()
		this.tui.addChild(this.editor)
		this.tui.addChild(this.footer)

		this.loader = new Loader(this.tui, ansi.cyan, (text) => ansi.bold(text), "working…")
		// Global keys: Esc/Ctrl-C abort a running task; Ctrl-C exits when idle.
		this.tui.addInputListener(data => this.handleGlobalInput(data))

		this.replaySession()
		void this.updateFooter()
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

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		if (!this.running && matchesKey(data, "ctrl+c")) {
			this.stop()
			return { consume: true }
		}
		if (this.running && matchesKey(data, "escape")) {
			this.abortRun()
			return { consume: true }
		}
		if (this.running && matchesKey(data, "ctrl+c")) {
			this.abortRun()
			return { consume: true }
		}
		return undefined
	}

	// ── submission ────────────────────────────────────────────────────

	private async submit(text: string): Promise<void> {
		const task = text.trim()
		if (task.length === 0) return
		if (this.running) {
			// Restore the typed text so it is not lost while a task is running.
			this.editor.setText(text)
			this.chat.addChild(notice("a task is already running — press Esc to abort it first"))
			this.tui.requestRender()
			return
		}

		this.chat.addChild(userMessage(task))
		this.running = true
		this.iteration = 0
		this.abort = new AbortController()
		this.showSpinner("working…")

		try {
			const result = await this.options.agent.run(this.options.session, task, {
				signal: this.abort.signal,
				onEvent: event => this.handleRunEvent(event),
			})
			if (result.aborted) {
				this.chat.addChild(notice("run aborted"))
			}
		} catch (err) {
			this.chat.addChild(errorNotice(err instanceof Error ? err.message : String(err)))
		} finally {
			this.running = false
			this.abort = null
			this.hideSpinner()
			this.updateFooter()
			this.tui.setFocus(this.editor)
			this.tui.requestRender()
		}
	}

	private abortRun(): void {
		if (this.abort !== null) {
			this.chat.addChild(notice("aborting…"))
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
				this.loader.setMessage(`iteration ${event.iteration}…`)
				this.updateFooter()
				break
			case "model_response": {
				// The assistant turn was just appended to the session; render its
				// text (tool calls arrive via tool_call events).
				if (event.usage !== undefined) {
					this.lastUsage = { input: event.usage.inputTokens, output: event.usage.outputTokens }
				}
				const last = this.options.session.lastAssistant()
				const text = last !== undefined
					? last.content.filter(part => part.type === "text").map(part => part.text).join("")
					: ""
				if (text.trim().length > 0) {
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
					this.pendingTools.delete(event.toolCallId)
				}
				break
			}
			case "compaction":
				this.chat.addChild(notice(`context compacted — ${event.summarizedMessages} messages summarized`))
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

	private async updateFooter(): Promise<void> {
		const model = await this.options.agent.currentModelLabel()
		const parts = [
			ansi.gray(model),
			this.running
				? ansi.yellow(`working (iteration ${this.iteration}) — Esc to abort`)
				: ansi.green("idle"),
		]
		if (this.lastUsage?.input !== undefined || this.lastUsage?.output !== undefined) {
			parts.push(ansi.gray(`tokens: ${this.lastUsage.input ?? 0} in / ${this.lastUsage.output ?? 0} out`))
		}
		this.footer.setText(parts.join(ansi.gray("  ·  ")))
		this.tui.requestRender()
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
	}

	/** Renders a message that was appended to the session outside of a run
	 *  (future use). */
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
