import {
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
import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Session } from "../session/session"
import type { RunEvent, SessionMessage } from "../session/types"
import type { MiniCode } from "../minicode"
import type { PromptTemplate, Skill } from "../config/resources"
import { loadResources } from "../config/resources"
import { isProjectTrusted } from "../config/trust"
import { ansi, markdownTheme } from "./theme"
import { Selector, type SelectorItem } from "./selector"
import { MiniCodeAutocomplete } from "./autocomplete"
import { expandFileReferences } from "./expand"
import { COMMANDS, findCommand, type CommandContext } from "./commands"
import {
	ToolExecutionComponent,
	assistantMessage,
	errorNotice,
	notice,
	replayMessage,
	userMessage,
} from "./components"

const IGNORED = new Set([".git", "node_modules", ".tool-output", ".minicode"])

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
 * The MiniCode main-screen TUI.
 * The runtime is the source of truth: `RunEvent`s map 1:1 onto component
 * updates and the editor submits through the existing `MiniCode.run()`.
 *
 * Keys: Enter submits — and steers while a task runs;
 * Alt+Enter queues a follow-up; Shift+Enter/Ctrl+J newline; Esc interrupts;
 * Ctrl-C clears (twice exits); Ctrl-D exits empty; Ctrl-O toggles tool
 * output; Ctrl-P cycles models.
 */
export class MiniCodeTui {
	private readonly tui: TuiMainScreen
	private readonly chat = new Container()
	private readonly status = new Container()
	private readonly editor: Editor
	private readonly footer = new Text("", 1, 0)

	private readonly loader: Loader
	private session: Session
	private running = false
	private iteration = 0
	private lastUsage: { input?: number; output?: number } | undefined
	private abort: AbortController | null = null
	private lastCtrlC = 0
	private toolsExpanded = false
	private modelContextWindow: number | undefined
	private gitBranch: string | undefined
	private readonly followUps: string[] = []
	private readonly pendingTools = new Map<string, ToolExecutionComponent>()
	private streaming: Container | null = null
	private streamingText = ""
	private selector: Selector | null = null
	private askState: AskState | null = null
	private promptTemplates: Array<{ name: string; description: string }> = []
	private reasoning: Container | null = null
	private readonly commandContext: CommandContext

	constructor(private readonly options: MiniCodeTuiOptions) {
		this.tui = new TuiMainScreen(new ProcessTerminal())
		this.session = options.session

		const hints = ansi.gray(
			"enter submit · esc interrupt · ctrl+c clear (twice exits) · ctrl+d exit · ctrl+o tools · ctrl+p model · /help commands",
		)
		const header = new Container()
		header.addChild(new Text(`${ansi.bold(ansi.cyan("MiniCode"))} ${ansi.gray(options.label ?? this.session.cwd)}`, 1, 0))
		header.addChild(new Text(`  ${hints}`, 0, 0))

		this.tui.addChild(header)
		this.tui.addChild(this.chat)
		this.tui.addChild(this.status)
		this.editor = this.createEditor()
		this.tui.addChild(this.editor)
		this.tui.addChild(this.footer)

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
				this.updateFooter()
				this.tui.requestRender()
			},
			notify: (text, isError) => {
				this.chat.addChild(isError === true ? errorNotice(text) : notice(text))
				this.tui.requestRender()
			},
			pick: async (title, items) => {
				const selector = new Selector(
					title,
					items as SelectorItem[],
				)
				return new Promise<string | null>(resolve => {
					selector.onSelect = value => {
						if (this.selector === selector) {
							this.chat.removeChild(selector)
							this.selector = null
						}
						this.tui.setFocus(this.editor)
						resolve(value)
					}
					selector.onCancel = () => {
						if (this.selector === selector) {
							this.chat.removeChild(selector)
							this.selector = null
						}
						this.tui.setFocus(this.editor)
						resolve(null)
					}
					this.selector = selector
					this.chat.addChild(selector)
					this.tui.setFocus(selector)
					this.tui.requestRender()
				})
			},
			ask: async label => {
				return new Promise<string | null>(resolve => {
					this.askState = { label, resolve: value => {
						this.status.clear()
						this.tui.setFocus(this.editor)
						resolve(value)
					} }
					this.status.addChild(new Text(ansi.bold(label), 1, 0))
					this.tui.setFocus(this.editor)
					this.tui.requestRender()
				})
			},
			compact: async () => {
				const model = await this.options.agent.currentModel()
				if (model === undefined) return false
				const { Compactor } = await import("../loop/compact")
				const compactor = new Compactor(model, model.limits.contextWindow)
				const removed = await compactor.compact(this.session)
				if (removed > 0) {
					this.chat.clear()
					this.replaySession()
					this.tui.requestRender()
				}
				return removed > 0
			},
			submitTask: async text => {
				await this.submit(text)
			},
			skills: (): Skill[] => this.currentSkills,
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
		editor.setAutocompleteProvider(new MiniCodeAutocomplete(
			() => [
				...COMMANDS.map(c => ({ name: c.name, description: c.description })),
				...this.promptTemplates.map(t => ({ name: t.name, description: t.description })),
			],
			() => this.session.cwd,
		))
		editor.onSubmit = (text: string) => {
			void this.submit(text)
		}
		return editor
	}

	private workspaceFiles(): string[] {
		const out: string[] = []
		const walk = (dir: string, rel: string, depth: number): void => {
			if (out.length >= 200 || depth > 8) return
			let entries
			try {
				entries = readdirSync(dir)
			} catch {
				return
			}
			for (const entry of entries) {
				if (out.length >= 200) return
				if (IGNORED.has(entry)) continue
				const full = join(dir, entry)
				const relative = rel === "" ? entry : `${rel}/${entry}`
				let isDir = false
				try {
					isDir = statSync(full).isDirectory()
				} catch {
					continue
				}
				if (isDir) walk(full, relative, depth + 1)
				else out.push(relative)
			}
		}
		walk(this.session.cwd, "", 0)
		return out
	}

	// ── global keys ───────────────────────────────────

	private handleGlobalInput(data: string): { consume?: boolean } | undefined {
		// An open selector owns the keyboard.
		if (this.selector !== null) return undefined

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
		if (matchesKey(data, "alt+enter")) {
			const text = this.editor.getText().trim()
			if (text.length === 0) return { consume: true }
			this.editor.setText("")
			if (this.running) {
				this.followUps.push(text)
				this.chat.addChild(notice(`queued (${this.followUps.length}) — runs after the current task`))
			} else {
				void this.submit(text)
			}
			this.tui.requestRender()
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
		this.updateFooter()
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
				await command.execute(this.commandContext, args)
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

		this.chat.addChild(userMessage(text))
		await this.startRun(expandFileReferences(text, this.session.cwd))
	}

	private readTemplate(name: string): string | null {
		const userDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "minicode", "prompts")
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
		this.iteration = 0
		this.abort = new AbortController()
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

		if (aborted && this.followUps.length > 0) {
			const restored = this.followUps.splice(0)
			this.editor.setText(restored.join("\n\n"))
			this.chat.addChild(notice("queued messages restored to the editor"))
			this.tui.requestRender()
			return
		}
		if (this.followUps.length > 0 && !aborted) {
			const next = this.followUps.shift()!
			await this.startRun(next)
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
				if (event.usage !== undefined) {
					this.lastUsage = { input: event.usage.inputTokens, output: event.usage.outputTokens }
				}
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
		const cwdShort = this.session.cwd.replace(/^\/home\/[^/]+/, "~").replace(/\/+$/, "") || "/"
		const branch = this.gitBranch !== undefined ? ` (${this.gitBranch})` : ""
		const parts = [ansi.gray(`${cwdShort}${branch}`)]
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

	private async refreshFooterData(): Promise<void> {
		const model = await this.options.agent.currentModel()
		if (model !== undefined) {
			this.modelContextWindow = model.limits.contextWindow
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
