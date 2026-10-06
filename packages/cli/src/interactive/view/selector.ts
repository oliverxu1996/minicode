import { Box, Container, Text, type Component } from "@minicode/tui"
import { ansi, surface } from "./theme"

export interface SelectorItem {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/**
 * Chat selector: arrow keys move, Enter confirms, Escape cancels. Focusable
 * through the `focused` flag so the TUI forwards key input to it while open.
 *
 * Rendered as an opaque panel: the content is wrapped in a background `Box`, so
 * when shown as an overlay it fully covers whatever is behind its bounds rather
 * than floating as bare text over the conversation.
 */
export class Selector implements Component {
  focused = false
  onSelect?: (value: string) => void
  onCancel?: () => void

  private readonly container = new Container()
  private readonly panel = new Box(0, 0, surface)
  private index = 0
  private readonly rendered: string[] = []

  constructor(
    readonly title: string,
    private readonly items: SelectorItem[],
  ) {
    this.panel.addChild(this.container)
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
    return this.panel.render(width)
  }
}
