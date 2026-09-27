import { Container, Text, type Component } from "@minicode/tui"
import { ansi } from "./theme"

export interface SelectorItem {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/**
 * Inline chat selector: arrow keys move, Enter confirms,
 * Escape cancels. Focusable through the `focused` flag so the TUI
 * forwards key input to it while open.
 */
export class Selector implements Component {
  focused = false
  onSelect?: (value: string) => void
  onCancel?: () => void

  private readonly container = new Container()
  private index = 0
  private readonly rendered: string[] = []

  constructor(
    readonly title: string,
    private readonly items: SelectorItem[],
  ) {
    this.rebuild()
  }

  private move(delta: number): void {
    this.index = Math.min(this.items.length - 1, Math.max(0, this.index + delta))
    this.rebuild()
  }

  private confirm(): void {
    const item = this.items[this.index]
    if (item !== undefined) this.onSelect?.(item.value)
  }

  private cancel(): void {
    this.onCancel?.()
  }

  private rebuild(): void {
    this.container.clear()
    this.container.addChild(new Text(`  ${ansi.bold(this.title)}`, 0, 0))
    this.items.forEach((item, i) => {
      const selected = i === this.index
      const marker = selected ? ansi.green("❯ ") : "  "
      const label = selected ? ansi.bold(item.label) : item.label
      const description = item.description !== undefined ? ` ${ansi.gray(item.description)}` : ""
      this.container.addChild(new Text(`${marker}${label}${description}`, 0, 0))
    })
    this.container.addChild(new Text(ansi.gray("  ↑/↓ move · enter select · esc cancel"), 0, 0))
  }

  handleInput(data: string): void {
    // Bare escape / arrows arrive as plain sequences here.
    if (data === "\x1b[A") this.move(-1)
    else if (data === "\x1b[B") this.move(1)
    else if (data === "\r" || data === "\n") this.confirm()
    else if (data === "\x1b" || data === "\x03") this.cancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    void this.rendered
    return this.container.render(width)
  }
}
