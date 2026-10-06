import { describe, expect, test } from "bun:test"
import { Selector } from "./selector"
import { surface } from "./theme"
import { stripSequences } from "./testing"

function items(): Array<{ value: string; label: string; description?: string }> {
	return [
		{ value: "one", label: "model one" },
		{ value: "two", label: "model two", description: "active" },
	]
}

describe("Selector opaque surface", () => {
	test("paints the surface background across every line at full width", () => {
		const selector = new Selector("Select model", items())
		for (const width of [80, 60, 40]) {
			const lines = selector.render(width)
			expect(lines.length).toBeGreaterThan(0)
			for (const line of lines) {
				// The whole padded line carries the panel background.
				expect(line.startsWith("\x1b[48;5;236m")).toBe(true)
				expect(line.endsWith("\x1b[49m")).toBe(true)
				// It is padded to the full overlay width, so no cell lacks a background.
				expect(stripSequences(line).length).toBe(width)
			}
		}
	})

	test("the surface is the shared panel color, not a new one", () => {
		expect(surface("x")).toBe("\x1b[48;5;236mx\x1b[49m")
		const lines = new Selector("t", items()).render(30)
		// Every line opens and closes the shared panel background.
		for (const line of lines) {
			expect(line.startsWith("\x1b[48;5;236m")).toBe(true)
			expect(line.endsWith("\x1b[49m")).toBe(true)
		}
	})

	test("small widths never produce negative or over-wide lines", () => {
		const selector = new Selector("Select model", items())
		for (const width of [1, 2, 5, 12]) {
			const lines = selector.render(width)
			for (const line of lines) {
				const visible = stripSequences(line).length
				expect(visible).toBeGreaterThanOrEqual(0)
				expect(visible).toBeLessThanOrEqual(width)
			}
		}
	})

	test("content stays inside the surface (title, items, hint)", () => {
		const rendered = new Selector("Select model", items()).render(50).map(stripSequences).join("\n")
		expect(rendered).toContain("Select model")
		expect(rendered).toContain("model one")
		expect(rendered).toContain("model two")
		expect(rendered).toContain("enter select")
	})
})

describe("Selector interaction", () => {
	test("arrow keys move the selection and Enter selects the highlighted item", () => {
		const selector = new Selector("Select model", items())
		let selected: string | undefined
		selector.onSelect = value => {
			selected = value
		}
		selector.handleInput("\x1b[B") // down -> two
		selector.handleInput("\r")
		expect(selected).toBe("two")
	})

	test("Escape cancels without selecting", () => {
		const selector = new Selector("Select model", items())
		let selected: string | undefined
		let cancelled = false
		selector.onSelect = value => {
			selected = value
		}
		selector.onCancel = () => {
			cancelled = true
		}
		selector.handleInput("\x1b")
		expect(cancelled).toBe(true)
		expect(selected).toBeUndefined()
	})
})
