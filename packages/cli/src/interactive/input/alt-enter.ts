import { matchesKey } from "@loongcode/tui"

/**
 * Translate Alt+Enter into a newline input for the focused editor.
 *
 * The editor inserts a newline for the legacy `ESC CR` sequence but not for the
 * Kitty CSI-u or xterm modifyOtherKeys encodings, so the application rewrites
 * the event to `"\n"` at the input-listener boundary instead of consuming it.
 * `Enter` (submit) is deliberately left untouched.
 */
export function altEnterAsNewline(data: string): { data: string } | undefined {
	return matchesKey(data, "alt+enter") ? { data: "\n" } : undefined
}
