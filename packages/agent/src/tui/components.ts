import { Container, Markdown, Text, type Component } from "@minicode/tui"
import type { SessionMessage } from "../session/types"
import { ansi, markdownTheme } from "./theme"

/**
 * MiniCode chat components, adapted from Pi's interactive-mode components
 * (assistant-message.ts, tool-execution.ts) down to what the v0.1 runtime
 * exposes: complete assistant texts and tool calls with string results.
 */

/** A submitted user task. */
export function userMessage(text: string): Component {
	return new Text(`${ansi.green("❯")} ${text}`, 1, 0)
}

/** A completed assistant response, rendered as Markdown. */
export function assistantMessage(text: string): Component {
	if (text.trim().length === 0) return new Text("", 0, 0)
	return new Markdown(text, 1, 0, markdownTheme())
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
 * preview collapsed to a few lines so large outputs never flood the
 * terminal.
 */
export class ToolExecutionComponent implements Component {
	private readonly container = new Container()
	private state: "running" | "success" | "error" = "running"
	private input: Record<string, unknown>
	private preview: string[] = []

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

	/** Refresh the arguments while the call is pending. */
	setInput(input: Record<string, unknown>): void {
		this.input = input
		this.rebuild()
	}

	/** Records the outcome; replaces the running line with the final one. */
	setResult(ok: boolean, result: string): void {
		this.state = ok ? "success" : "error"

		const plain = result.replace(/\x1b\[[0-9;]*m/g, "")
		const lines = plain.split("\n").filter(line => line.trim().length > 0)
		const preview: string[] = []
		for (const line of lines.slice(0, 3)) {
			preview.push(`      ${ansi.gray(line.length > 120 ? `${line.slice(0, 120)}…` : line)}`)
		}
		if (lines.length > 3) {
			preview.push(`      ${ansi.gray(`… (${lines.length - 3} more lines)`)}`)
		}
		this.preview = preview
		this.rebuild()
	}

	private headerLine(): string {
		const args = toolArgumentSummary(this.name, this.input)
		const suffix = args.length > 0 ? ` ${ansi.gray(args)}` : ""
		switch (this.state) {
			case "running":
				return `  ${ansi.cyan("▸")} ${ansi.bold(this.name)}${suffix}`
			case "success":
				return `  ${ansi.green("✓")} ${ansi.bold(this.name)}${suffix}`
			case "error":
				return `  ${ansi.red("✗")} ${ansi.bold(this.name)}${suffix}`
		}
	}

	private rebuild(): void {
		this.container.clear()
		this.container.addChild(new Text(this.headerLine(), 0, 0))
		for (const line of this.preview) {
			this.container.addChild(new Text(line, 0, 0))
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
