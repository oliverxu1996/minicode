import { Box, Container, Markdown, Spacer, Text, type Component } from "@minicode/tui"
import type { SessionMessage } from "../session/types"
import { ansi, markdownTheme } from "./theme"
import { formatDuration } from "./projection"

/**
 * MiniCode chat components for the runtime's message model.
 */

/** Maximum result lines kept per tool component (expanded rendering caps
 *  here too, so pathological outputs cannot exhaust memory). */
const MAX_RESULT_LINES = 500

/** A submitted user task: markdown in a background-filled box. */
export function userMessage(text: string): Component {
	const box = new Box(1, 0, (line) => `\x1b[48;5;236m${line}\x1b[49m`)
	box.addChild(
		new Markdown(text.trim(), 0, 0, markdownTheme(), {
			color: (content) => `\x1b[97m${content}\x1b[39m`,
		}),
	)
	const wrapper = new Container()
	wrapper.addChild(new Text("", 0, 0))
	wrapper.addChild(box)
	return wrapper
}

/** A completed assistant response, rendered as Markdown with a leading spacer. */
export function assistantMessage(text: string): Component {
	const container = new Container()
	if (text.trim().length === 0) return container
	container.addChild(new Spacer(1))
	container.addChild(new Markdown(text.trim(), 1, 0, markdownTheme()))
	return container
}

/** A dim notice line (compaction, recovery, abort notices). */
export function notice(text: string): Component {
	return new Text(`  ${ansi.gray(text)}`, 1, 0)
}

/** An error notice — visually distinct from ordinary output. */
export function errorNotice(text: string): Component {
	return new Text(`  ${ansi.red(`error: ${text}`)}`, 1, 0)
}

/** Summarizes a tool's input into a short, human-readable argument hint. */
export function toolArgumentSummary(name: string, input: Record<string, unknown>): string {
	const summarize = (value: unknown, max: number): string => {
		const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""
		const flat = text.replace(/\s+/g, " ").trim()
		return flat.length > max ? `${flat.slice(0, max)}…` : flat
	}
	switch (name) {
		case "bash":
			return summarize(input.command, 80)
		case "read":
		case "write":
		case "edit":
			return summarize(input.filePath, 60)
		case "grep":
		case "find":
			return summarize(input.pattern, 60)
		case "ls":
			return typeof input.path === "string" ? input.path : ""
		default:
			return summarize(input, 60)
	}
}

/**
 * One tool call line with its result: running → success/failure, with the result
 * collapsed to a preview plus a "more lines" hint; Ctrl-O toggles the
 * full output for every tool at once.
 */
export class ToolExecutionComponent implements Component {
	private readonly container = new Container()
	private state: "running" | "success" | "error" = "running"
	private input: Record<string, unknown>
	private fullLines: string[] = []
	private expanded = false
	private durationMs: number | undefined

	constructor(
		readonly toolCallId: string,
		readonly name: string,
		input: Record<string, unknown>,
	) {
		this.input = input
		this.rebuild()
	}

	/** Required by the component interface; nothing to invalidate. */
	invalidate(): void {}

	/** Live partial output while the tool is still running (bash). */
	setProgress(text: string): void {
		if (this.state !== "running") return
		const plain = text.replace(/\x1b\[[0-9;]*m/g, "")
		const lines = plain.split("\n").filter(line => line.trim().length > 0)
		this.progressPreview = lines.slice(-3).map(line => `      ${ansi.gray(line.slice(0, 120))}`)
		this.rebuild()
	}

	private progressPreview: string[] = []

	/** Records the outcome; replaces the running line with the final one.
	 *
	 *  `durationMs` is the runtime's own figure, passed through untouched —
	 *  the UI never times a tool itself, and an unreported duration stays
	 *  absent rather than rendering as an instant zero. */
	setResult(ok: boolean, result: string, durationMs?: number): void {
		this.state = ok ? "success" : "error"
		this.durationMs = durationMs

		const plain = result.replace(/\x1b\[[0-9;]*m/g, "")
		this.fullLines = plain
			.split("\n")
			.filter(line => line.trim().length > 0)
			.slice(0, MAX_RESULT_LINES)
			.map(line => (line.length > 200 ? `${line.slice(0, 200)}…` : line))
		this.rebuild()
	}

	/** Ctrl-O toggles full output for every tool component. */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded
		this.rebuild()
	}

	private headerLine(): string {
		const args = toolArgumentSummary(this.name, this.input)
		const suffix = args.length > 0 ? ` ${ansi.gray(args)}` : ""
		const took = this.durationMs === undefined ? "" : ` ${ansi.gray(`· ${formatDuration(this.durationMs)}`)}`
		switch (this.state) {
			case "running":
				return `  ${ansi.cyan("▸")} ${ansi.bold(this.name)}${suffix}`
			case "success":
				return `  ${ansi.green("✓")} ${ansi.bold(this.name)}${suffix}${took}`
			case "error":
				return `  ${ansi.red("✗")} ${ansi.bold(this.name)}${suffix}${took}`
		}
	}

	private rebuild(): void {
		this.container.clear()
		this.container.addChild(new Text(this.headerLine(), 0, 0))
		if (this.state === "running") {
			for (const line of this.progressPreview) {
				this.container.addChild(new Text(line, 0, 0))
			}
		} else {
			const shown = this.expanded ? this.fullLines : this.fullLines.slice(0, 3)
			for (const line of shown) {
				this.container.addChild(new Text(`      ${ansi.gray(line)}`, 0, 0))
			}
			const remaining = this.fullLines.length - shown.length
			if (remaining > 0) {
				this.container.addChild(
					new Text(`      ${ansi.gray(`… (${remaining} more lines, ctrl+o to expand)`)}`, 0, 0),
				)
			}
		}
	}

	render(width: number): string[] {
		return this.container.render(width)
	}
}

/** Replays one persisted history message into chat components. */
export function replayMessage(
	message: SessionMessage,
	resultsByCallId: Map<string, { ok: boolean; result: string }>,
): Component[] {
	const components: Component[] = []
	if (message.role === "user") {
		components.push(userMessage(message.content))
		return components
	}
	if (message.role === "assistant") {
		let text = ""
		for (const part of message.content) {
			if (part.type === "text") {
				text += part.text
				continue
			}
			if (part.type === "tool_call") {
				if (text.trim().length > 0) {
					components.push(assistantMessage(text))
					text = ""
				}
				const component = new ToolExecutionComponent(
					part.toolCallId,
					part.toolName,
					part.input as Record<string, unknown>,
				)
				const recorded = resultsByCallId.get(part.toolCallId)
				if (recorded !== undefined) {
					component.setResult(recorded.ok, recorded.result)
				}
				components.push(component)
			}
		}
		if (text.trim().length > 0) components.push(assistantMessage(text))
		return components
	}
	return components
}
