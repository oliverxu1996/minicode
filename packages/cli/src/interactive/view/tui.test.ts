import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@minicode/agent"
import { ToolExecutionComponent, replayMessage, toolArgumentSummary } from "./components"
import { findCommand, type CommandContext } from "../commands"

function render(component: { render(width: number): string[] }): string {
	return component.render(100).join("\n")
}

describe("reload command", () => {
	test("/reload refreshes the UI's cached resources, so its confirmation is true", async () => {
		const reload = findCommand("reload")
		expect(reload).toBeDefined()

		let reloaded = 0
		const notices: string[] = []
		const ctx = {
			reloadResources: (): void => { reloaded += 1 },
			notify: (text: string): void => { notices.push(text) },
		} as unknown as CommandContext

		await reload!.execute(ctx, "")

		// The command must actually perform the refresh it reports. It used to
		// call an empty no-op and print the confirmation regardless.
		expect(reloaded).toBe(1)
		expect(notices).toHaveLength(1)
	})
})

describe("TUI component mapping (V2)", () => {
	test("tool component renders a running line, then success with a collapsed result", () => {
		const component = new ToolExecutionComponent("call_1", "bash", { command: "bun test" })
		const running = render(component)
		expect(running).toContain("▸")
		expect(running).toContain("bash")
		expect(running).toContain("bun test")

		component.setResult(true, "3 pass\n0 fail\nRan 3 tests\ndone in 12ms")
		const done = render(component)
		expect(done).toContain("✓")
		expect(done).toContain("3 pass")
		expect(done).toContain("(1 more lines, ctrl+o to expand)")
		expect(done).not.toContain("done in 12ms")
	})

	test("tool component renders failures distinctly", () => {
		const component = new ToolExecutionComponent("call_2", "read", { filePath: "missing.ts" })
		component.setResult(false, "File not found: missing.ts")
		const done = render(component)
		expect(done).toContain("✗")
		expect(done).toContain("File not found")
	})

	test("tool argument summaries stay short", () => {
		const long = toolArgumentSummary("bash", { command: `echo ${"x".repeat(200)}` })
		expect(long.length).toBeLessThanOrEqual(81)
		expect(long.endsWith("…")).toBe(true)
		expect(toolArgumentSummary("read", { filePath: "src/a.ts" })).toBe("src/a.ts")
	})

	test("replay renders user, assistant, and correlated tool history", () => {
		const messages: SessionMessage[] = [
			{ id: "1", role: "user", content: "fix the bug", status: "complete", timestamp: 1 },
			{
				id: "2",
				role: "assistant",
				content: [
					{ type: "text", text: "Looking at the file." },
					{ type: "tool_call", toolCallId: "call_1", toolName: "read", input: { filePath: "a.ts" } },
				],
				status: "complete",
				timestamp: 2,
			},
			{
				id: "3",
				role: "tool",
				content: [{ toolCallId: "call_1", toolName: "read", output: { type: "text", text: "1: ok" } }],
				status: "complete",
				timestamp: 3,
			},
			{
				id: "4",
				role: "assistant",
				content: [{ type: "text", text: "**Fixed.**" }],
				status: "complete",
				timestamp: 4,
			},
		]

		const results = new Map([["call_1", { ok: true, result: "1: ok" }]])
		const components = messages.flatMap(message => replayMessage(message, results))
		const rendered = components.map(component => render(component as { render(width: number): string[] }))

		expect(rendered[0]).toContain("fix the bug")
		expect(rendered[1]).toContain("Looking at the file.")
		expect(rendered[2]).toContain("read")
		expect(rendered[2]).toContain("✓")
		expect(rendered[3]).toContain("Fixed.")
	})

	test("replay renders failed tool history with the failure marker", () => {
		const messages: SessionMessage[] = [
			{
				id: "1",
				role: "assistant",
				content: [{ type: "tool_call", toolCallId: "call_9", toolName: "bash", input: { command: "exit 1" } }],
				status: "complete",
				timestamp: 1,
			},
			{
				id: "2",
				role: "tool",
				content: [{ toolCallId: "call_9", toolName: "bash", output: { type: "tool_error", text: "boom" } }],
				status: "complete",
				timestamp: 2,
			},
		]

		const results = new Map([["call_9", { ok: false, result: "boom" }]])
		const components = messages.flatMap(message => replayMessage(message, results))
		const rendered = components.map(component => render(component as { render(width: number): string[] }))
		expect(rendered[0]).toContain("✗")
		expect(rendered[0]).toContain("boom")
	})
})
