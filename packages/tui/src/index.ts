/**
 * Terminal UI framework used by the LoongCode TUI.
 */

export { TuiMainScreen } from "./tui-main-screen.ts"
export { TuiAltScreen, type TuiAltScreenOptions } from "./tui-alt-screen.ts"
export {
	Container,
	type Component,
	type Focusable,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "./tui.ts"
export { ProcessTerminal, type Terminal } from "./terminal.ts"
export { matchesKey } from "./keys.ts"
export type { AutocompleteProvider, AutocompleteSuggestions, AutocompleteItem } from "./autocomplete.ts"
export { Editor, type EditorTheme } from "./components/editor.ts"
export { Markdown, type MarkdownOptions, type MarkdownTheme } from "./components/markdown.ts"
export { Loader, type LoaderIndicatorOptions } from "./components/loader.ts"
export { Text } from "./components/text.ts"
export { Box } from "./components/box.ts"
export { Spacer } from "./components/spacer.ts"
export { TruncatedText } from "./components/truncated-text.ts"
export { Stack, type StackOptions } from "./components/stack.ts"
export { VStack, type StackChild, type StackEntryOptions } from "./components/v-stack.ts"
export {
	ScrollView,
	type ScrollViewOptions,
	type ScrollViewScrollbar,
	type ScrollViewScrollToOptions,
} from "./components/scroll-view.ts"
