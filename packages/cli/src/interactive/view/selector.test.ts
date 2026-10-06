import { describe, expect, test } from "bun:test"
import { Selector, pickerVisibleItems } from "./selector"
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

  test("selectedValue highlights an existing choice when the picker opens", () => {
    const picker = new Selector(
      "Protocol",
      [{ value: "openai", label: "OpenAI-compatible" }, { value: "anthropic", label: "Anthropic" }],
      "anthropic",
    )
    let selected: string | undefined
    picker.onSelect = value => {
      selected = value
    }
    // Enter confirms the pre-highlighted item, not the first.
    picker.handleInput("\r")
    expect(selected).toBe("anthropic")
  })

  test("an unknown selectedValue falls back to the first item", () => {
    const picker = new Selector("Protocol", [{ value: "openai", label: "A" }, { value: "anthropic", label: "B" }], "ghost")
    let selected: string | undefined
    picker.onSelect = value => {
      selected = value
    }
    picker.handleInput("\r")
    expect(selected).toBe("openai")
  })
})

describe("Selector windowing", () => {
	function many(count: number): Array<{ value: string; label: string }> {
		return Array.from({ length: count }, (_, i) => ({ value: String(i), label: `item ${i}` }))
	}

	test("a cap shows only that many item rows plus title and hint", () => {
		const selector = new Selector("Pick", many(20))
		selector.setMaxVisibleItems(3)
		const lines = selector.render(30).map(stripSequences)
		// title + 3 items + hint
		expect(lines).toHaveLength(5)
		expect(lines[0]).toContain("Pick")
		expect(lines[4]).toContain("enter select")
	})

	test("moving past the window scrolls it to keep the selection visible", () => {
		const selector = new Selector("Pick", many(20))
		selector.setMaxVisibleItems(3)
		for (let i = 0; i < 10; i++) selector.handleInput("\x1b[B")
		const lines = selector.render(30).map(stripSequences)
		expect(lines).toHaveLength(5)
		const selected = lines.find(line => line.includes("❯"))
		expect(selected).toContain("item 10")
	})

	test("an unbounded selector shows every item", () => {
		const selector = new Selector("Pick", many(5))
		expect(selector.render(30).length).toBe(5 + 2)
	})

	test("pickerVisibleItems reserves room for the composer and footer", () => {
		expect(pickerVisibleItems(24)).toBe(15)
		expect(pickerVisibleItems(12)).toBe(3)
		// Never below one item row, even on a too-small terminal.
		expect(pickerVisibleItems(8)).toBe(1)
		expect(pickerVisibleItems(4)).toBe(1)
	})
})
