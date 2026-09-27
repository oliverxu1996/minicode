import type { MarkdownTheme } from "@minicode/tui"

/**
 * Minimal ANSI theme for the MiniCode TUI: a fixed set of transforms, no
 * color-scheme loading.
 */

export const ansi = {
	bold: (text: string): string => `\x1b[1m${text}\x1b[22m`,
	dim: (text: string): string => `\x1b[2m${text}\x1b[22m`,
	italic: (text: string): string => `\x1b[3m${text}\x1b[23m`,
	underline: (text: string): string => `\x1b[4m${text}\x1b[24m`,
	strikethrough: (text: string): string => `\x1b[9m${text}\x1b[29m`,
	red: (text: string): string => `\x1b[31m${text}\x1b[39m`,
	green: (text: string): string => `\x1b[32m${text}\x1b[39m`,
	cyan: (text: string): string => `\x1b[36m${text}\x1b[39m`,
	yellow: (text: string): string => `\x1b[33m${text}\x1b[39m`,
	gray: (text: string): string => `\x1b[90m${text}\x1b[39m`,
}

export function markdownTheme(): MarkdownTheme {
	return {
		heading: (text) => ansi.bold(ansi.cyan(text)),
		link: (text) => ansi.underline(ansi.cyan(text)),
		linkUrl: (text) => ansi.gray(text),
		code: (text) => ansi.yellow(text),
		codeBlock: (text) => text,
		codeBlockBorder: (text) => ansi.gray(text),
		quote: (text) => ansi.gray(text),
		quoteBorder: (text) => ansi.gray(text),
		hr: (text) => ansi.gray(text),
		listBullet: (text) => ansi.cyan(text),
		bold: (text) => ansi.bold(text),
		italic: (text) => ansi.italic(text),
		strikethrough: (text) => ansi.strikethrough(text),
		underline: (text) => ansi.underline(text),
	}
}

export function editorTheme(): import("@minicode/tui").EditorTheme {
	return {
		borderColor: (text) => ansi.gray(text),
		selectList: {
			selectedPrefix: (text) => ansi.green(text),
			selectedText: (text) => ansi.bold(text),
			description: (text) => ansi.gray(text),
			scrollInfo: (text) => ansi.gray(text),
			noMatch: (text) => ansi.red(text),
		},
	}
}
