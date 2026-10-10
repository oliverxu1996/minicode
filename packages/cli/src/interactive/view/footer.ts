import type { Component } from "@loongcode/tui"
import { ansi } from "./theme"
import {
  displayWidth,
  fitFooterRow,
  footerRowText,
  truncatePlain,
  type FooterPart,
  type FooterRow,
} from "../../projection"

/** Applies a part's tone. The projection decides meaning, not color. */
function paint(part: FooterPart): string {
  switch (part.tone) {
    case "warn":
      return ansi.yellow(part.text)
    case "ok":
      return ansi.green(part.text)
    case "alert":
      return ansi.red(part.text)
    case "dim":
      return ansi.gray(part.text)
  }
}

const SEPARATOR = " · "

/**
 * One footer row, rendered as exactly one width-bounded line.
 *
 * The projection's `fitFooterRow` decides what is shown (deterministic drop
 * order); this component only paints tones and guarantees the line never
 * exceeds the viewport. A `Text` component would word-wrap instead, which would
 * turn a two-row footer into three rows on a narrow terminal.
 */
export class FooterLineView implements Component {
  private row: FooterRow | undefined

  setRow(row: FooterRow | undefined): void {
    this.row = row
  }

  /** No cached state; each render reflects the most recent row. */
  invalidate(): void {}

  render(width: number): string[] {
    if (this.row === undefined) return []
    if (width <= 0) return [""]

    const lead = width >= 2 ? " " : ""
    const avail = Math.max(1, width - displayWidth(lead))
    const fitted = fitFooterRow(this.row, avail)
    const plain = footerRowText(fitted)

    // Paint when the fitted row fits; otherwise fall back to a plain truncation
    // so the line can never exceed the viewport (the framework warns/errors on
    // an over-wide line).
    const content =
      displayWidth(plain) <= avail
        ? fitted.groups.map(group => group.parts.map(paint).join(" ")).join(ansi.gray(SEPARATOR))
        : truncatePlain(plain, avail)

    const visible = Math.min(displayWidth(plain), avail)
    const pad = Math.max(0, width - displayWidth(lead) - visible)
    return [lead + content + " ".repeat(pad)]
  }
}
