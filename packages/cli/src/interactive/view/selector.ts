import { Box, Container, TruncatedText, type Component } from "@loongcode/tui"
import { ansi, surface } from "./theme"

export interface SelectorItem {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/**
 * Chrome rows the picker must leave below itself: the composer (top border +
 * content + bottom border), the two footer rows, and a two-row status region.
 * The picker never renders taller than this reservation allows, so an open
 * picker cannot push the composer or footer off-screen.
 */
const PICKER_CHROME_ROWS = 9

/**
 * Maximum number of item rows the picker may show for a terminal of the given
 * height. The picker adds a title row and a hint row around the items.
 */
export function pickerVisibleItems(terminalRows: number): number {
  return Math.max(1, Math.floor(terminalRows) - PICKER_CHROME_ROWS)
}

/**
 * Chat selector: arrow keys move, Enter confirms, Escape cancels. Focusable
 * through the `focused` flag so the TUI forwards key input to it while open.
 *
 * Rendered as an opaque panel: the content is wrapped in a background `Box`.
 * The list is windowed to `maxVisibleItems` rows so the panel stays bounded on
 * any terminal and the selected item remains visible.
 */
export class Selector implements Component {
  focused = false
  onSelect?: (value: string) => void
  onCancel?: () => void

  private readonly container = new Container()
  private readonly panel = new Box(0, 0, surface)
  private index = 0
  private scrollOffset = 0
  private maxVisibleItems = Number.POSITIVE_INFINITY

  constructor(
    readonly title: string,
    private readonly items: SelectorItem[],
    /** Value highlighted when the picker opens; used to show a current
     *  selection (e.g. the protocol being edited). Falls back to the first. */
    selectedValue?: string,
  ) {
    if (selectedValue !== undefined) {
      const index = items.findIndex(item => item.value === selectedValue)
      if (index >= 0) this.index = index
    }
    this.panel.addChild(this.container)
    this.rebuild()
  }

  /** Cap the number of item rows rendered; keeps the selected item in view. */
  setMaxVisibleItems(count: number): void {
    const next = Number.isFinite(count) && count >= 1 ? Math.floor(count) : Number.POSITIVE_INFINITY
    if (next === this.maxVisibleItems) return
    this.maxVisibleItems = next
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

  private visibleRange(): { start: number; end: number } {
    const maxItems = Number.isFinite(this.maxVisibleItems)
      ? Math.max(1, this.maxVisibleItems)
      : this.items.length
    // Keep the selected item inside the window.
    if (this.index < this.scrollOffset) this.scrollOffset = this.index
    else if (this.index >= this.scrollOffset + maxItems) this.scrollOffset = this.index - maxItems + 1
    const maxOffset = Math.max(0, this.items.length - maxItems)
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset))
    const start = this.scrollOffset
    const end = Math.min(this.items.length, start + maxItems)
    return { start, end }
  }

  private rebuild(): void {
    const { start, end } = this.visibleRange()
    this.container.clear()
    // Each row is a single truncated line, so the panel's height is exactly
    // `visibleItems + 2` regardless of terminal width or label length.
    this.container.addChild(new TruncatedText(`  ${ansi.bold(this.title)}`, 0, 0))
    for (let i = start; i < end; i++) {
      const item = this.items[i]!
      const selected = i === this.index
      const marker = selected ? ansi.green("❯ ") : "  "
      const label = selected ? ansi.bold(item.label) : item.label
      const description = item.description !== undefined ? ` ${ansi.gray(item.description)}` : ""
      this.container.addChild(new TruncatedText(`${marker}${label}${description}`, 0, 0))
    }
    this.container.addChild(new TruncatedText(ansi.gray("  ↑/↓ move · enter select · esc cancel"), 0, 0))
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
    return this.panel.render(width)
  }
}

/** A component that caps how many item rows it renders. */
interface VisibleItemCapped {
  setMaxVisibleItems(count: number): void
}

function hasVisibleItemCap(component: Component): component is Component & VisibleItemCapped {
  return typeof (component as { setMaxVisibleItems?: unknown }).setMaxVisibleItems === "function"
}

/**
 * The bottom-attached picker slot: a fixed-height VStack entry directly above
 * the composer. It renders the active component, or nothing when closed, so an
 * open picker consumes conversation viewport height instead of floating over
 * the conversation. `maxVisibleItems` is read every render so the window follows
 * terminal resizes.
 *
 * It hosts the generic {@link Selector} and richer transient features (such as
 * the session manager) alike; a hosted component that supports a windowing cap
 * is handed one each render.
 */
export class PickerSlot implements Component {
  private component: Component | null = null

  constructor(private readonly maxVisibleItems: () => number = () => Number.POSITIVE_INFINITY) {}

  /** Show `selector` in the slot, or clear it with null. */
  setSelector(selector: Selector | null): void {
    this.component = selector
  }

  /** Show any transient component in the slot, or clear it with null. */
  setComponent(component: Component | null): void {
    this.component = component
  }

  invalidate(): void {
    this.component?.invalidate()
  }

  render(width: number): string[] {
    if (this.component === null) return []
    if (hasVisibleItemCap(this.component)) this.component.setMaxVisibleItems(this.maxVisibleItems())
    return this.component.render(width)
  }
}
