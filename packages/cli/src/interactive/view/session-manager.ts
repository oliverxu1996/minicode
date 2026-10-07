import { Box, Container, TruncatedText, type Component } from "@minicode/tui"
import { ansi, surface } from "./theme"
import { filterSessions, relatedSessions, type ScopedSessionSummary } from "../session/scope"

/**
 * The interactive `/session` manager.
 *
 * A focused feature component (not a generic list framework): it renders the
 * workspace-scoped candidate set in the bottom-attached picker slot and turns
 * user intent into a single {@link SessionManagerAction}. Runtime mutation —
 * switching, renaming, deleting, forking, cloning, and fetching a selected
 * session — is the application's job, so this component holds no session state
 * beyond the summaries it was given. Every list it shows is derived from that
 * already-scoped set, so it can never surface another workspace's session.
 */

/** What the user chose. The application executes it and owns all side effects. */
export type SessionManagerAction =
  | { readonly kind: "switch"; readonly id: string }
  | { readonly kind: "rename"; readonly id: string }
  | { readonly kind: "delete"; readonly id: string }
  | { readonly kind: "fork"; readonly id: string }
  | { readonly kind: "clone"; readonly id: string }
  | { readonly kind: "close" }

type Mode = "list" | "search" | "related" | "confirm"

export class SessionManager implements Component {
	focused = false
	onAction?: (action: SessionManagerAction) => void

	private readonly container = new Container()
	private readonly panel = new Box(0, 0, surface)
	private mode: Mode = "list"
	private query = ""
	private index = 0
	private scrollOffset = 0
	private maxVisibleItems = Number.POSITIVE_INFINITY
	private message: string | null = null
	/** Parent whose direct children the related view shows. */
	private relatedParentId: string | null = null
	/** Session awaiting delete confirmation. */
	private pendingDeleteId: string | null = null
	private resolved = false

	constructor(
		private readonly sessions: readonly ScopedSessionSummary[],
		private readonly currentId: string,
		readonly title: string,
	) {
		const currentIndex = sessions.findIndex(session => session.id === currentId)
		if (currentIndex >= 0) this.index = currentIndex
		this.panel.addChild(this.container)
		this.rebuild()
	}

	/** Cap the number of item rows rendered; keeps the selection in view. */
	setMaxVisibleItems(count: number): void {
		const next = Number.isFinite(count) && count >= 1 ? Math.floor(count) : Number.POSITIVE_INFINITY
		if (next === this.maxVisibleItems) return
		this.maxVisibleItems = next
		this.rebuild()
	}

	// ── input ────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (data === "\x1b[A") this.move(-1)
		else if (data === "\x1b[B") this.move(1)
		else if (data === "\r" || data === "\n") this.confirm()
		else if (data === "\x1b" || data === "\x03") this.escape()
		else if (data === "\x7f" || data === "\b") this.backspace()
		else if (data.length === 1 && data.charCodeAt(0) >= 0x20 && data.charCodeAt(0) !== 0x7f) this.handleChar(data)
	}

	private move(delta: number): void {
		// The confirmation is bound to one session; navigation is not meaningful.
		if (this.mode === "confirm") return
		const count = this.items().length
		if (count === 0) return
		this.message = null
		this.index = Math.min(count - 1, Math.max(0, this.index + delta))
		this.rebuild()
	}

	private confirm(): void {
		const item = this.items()[this.index]
		if (this.mode === "confirm") {
			if (this.pendingDeleteId !== null) this.emit({ kind: "delete", id: this.pendingDeleteId })
			return
		}
		if (item === undefined) return
		if (this.mode === "list" && item.id === this.currentId) {
			this.emit({ kind: "close" })
			return
		}
		this.emit({ kind: "switch", id: item.id })
	}

	private escape(): void {
		if (this.mode === "search") {
			if (this.query.length > 0) {
				this.query = ""
				this.mode = "list"
				this.index = this.indexForCurrentOrZero()
				this.rebuild()
				return
			}
			this.emit({ kind: "close" })
			return
		}
		if (this.mode === "related") {
			this.mode = "list"
			this.message = null
			this.index = this.indexForCurrentOrZero()
			this.rebuild()
			return
		}
		if (this.mode === "confirm") {
			this.mode = "list"
			this.pendingDeleteId = null
			this.rebuild()
			return
		}
		this.emit({ kind: "close" })
	}

	private backspace(): void {
		if (this.mode !== "search" || this.query.length === 0) return
		this.query = this.query.slice(0, -1)
		this.clampIndex()
		this.rebuild()
	}

	private handleChar(char: string): void {
		this.message = null
		if (this.mode === "search") {
			this.query += char
			this.clampIndex()
			this.rebuild()
			return
		}
		if (this.mode === "related" || this.mode === "confirm") return

		const item = this.items()[this.index]
		if (item === undefined) return
		switch (char) {
			case "/":
				this.mode = "search"
				this.query = ""
				this.rebuild()
				break
			case "r":
				this.emit({ kind: "rename", id: item.id })
				break
			case "d":
				if (item.id === this.currentId) {
					this.message = "cannot delete the current session"
					this.rebuild()
				} else {
					this.pendingDeleteId = item.id
					this.mode = "confirm"
					this.rebuild()
				}
				break
			case "f":
				this.emit({ kind: "fork", id: item.id })
				break
			case "c":
				this.emit({ kind: "clone", id: item.id })
				break
			case "t":
				this.openRelated(item.id)
				break
			default:
				break
		}
	}

	private openRelated(parentId: string): void {
		if (relatedSessions(this.sessions, parentId).length === 0) {
			this.message = "No forked sessions under this one"
			this.rebuild()
			return
		}
		this.relatedParentId = parentId
		this.mode = "related"
		this.index = 0
		this.rebuild()
	}

	private emit(action: SessionManagerAction): void {
		if (this.resolved) return
		this.resolved = true
		this.onAction?.(action)
	}

	private indexForCurrentOrZero(): number {
		const found = this.items().findIndex(session => session.id === this.currentId)
		return found >= 0 ? found : 0
	}

	private clampIndex(): void {
		const count = this.items().length
		this.index = count === 0 ? 0 : Math.min(this.index, count - 1)
	}

	/** The sessions currently displayed, always drawn from the scoped set. */
	private items(): ScopedSessionSummary[] {
		if (this.mode === "related" && this.relatedParentId !== null) {
			return relatedSessions(this.sessions, this.relatedParentId)
		}
		return filterSessions(this.sessions, this.mode === "search" ? this.query : "")
	}

	private labelOf(session: ScopedSessionSummary): string {
		return session.title ?? session.firstUser ?? "(untitled)"
	}

	// ── rendering ────────────────────────────────────────────────────

	private visibleRange(): { start: number; end: number } {
		const items = this.items()
		const maxItems = Number.isFinite(this.maxVisibleItems) ? Math.max(1, this.maxVisibleItems) : items.length
		if (this.index < this.scrollOffset) this.scrollOffset = this.index
		else if (this.index >= this.scrollOffset + maxItems) this.scrollOffset = this.index - maxItems + 1
		const maxOffset = Math.max(0, items.length - maxItems)
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset))
		const start = this.scrollOffset
		const end = Math.min(items.length, start + maxItems)
		return { start, end }
	}

	private rebuild(): void {
		const items = this.items()
		this.clampIndex()
		const { start, end } = this.visibleRange()
		this.container.clear()
		this.container.addChild(new TruncatedText(`  ${ansi.bold(this.title)}`, 0, 0))

		if (this.mode === "search") {
			this.container.addChild(new TruncatedText(`  ${ansi.gray("/")}${this.query}`, 0, 0))
		}
		if (this.mode === "related" && this.relatedParentId !== null) {
			const parent = this.sessions.find(session => session.id === this.relatedParentId)
			this.container.addChild(new TruncatedText(`  ${ansi.gray(`Related · ${parent !== undefined ? this.labelOf(parent) : ""}`)}`, 0, 0))
		}
		if (this.mode === "confirm" && this.pendingDeleteId !== null) {
			const target = this.sessions.find(session => session.id === this.pendingDeleteId)
			const label = target !== undefined ? this.labelOf(target) : this.pendingDeleteId
			this.container.addChild(new TruncatedText(`  ${ansi.red(`Delete "${label}"? This cannot be undone.`)}`, 0, 0))
		}

		if (items.length === 0) {
			this.container.addChild(new TruncatedText(`  ${ansi.gray(this.emptyText())}`, 0, 0))
		}
		for (let i = start; i < end; i++) {
			const session = items[i]!
			const selected = i === this.index
			const marker = selected ? ansi.green("❯ ") : "  "
			const current = session.id === this.currentId ? "• " : session.parentSessionId !== null ? "↳ " : "  "
			const label = selected ? ansi.bold(this.labelOf(session)) : this.labelOf(session)
			const description = ` ${ansi.gray(`${session.messageCount} msgs · ${new Date(session.updatedAt).toLocaleString()}`)}`
			this.container.addChild(new TruncatedText(`${marker}${current}${label}${description}`, 0, 0))
		}

		if (this.message !== null) {
			this.container.addChild(new TruncatedText(`  ${ansi.yellow(this.message)}`, 0, 0))
		}
		this.container.addChild(new TruncatedText(`  ${ansi.gray(this.hintText())}`, 0, 0))
	}

	private emptyText(): string {
		if (this.mode === "search") return "No matching sessions"
		if (this.mode === "related") return "No forked sessions under this one"
		return "No sessions in this workspace"
	}

	private hintText(): string {
		switch (this.mode) {
			case "search":
				return "type to filter · ↑/↓ move · enter open · esc clear/close"
			case "related":
				return "enter open · esc back"
			case "confirm":
				return "enter confirm · esc cancel"
			default:
				return "enter open · / search · r rename · d delete · f fork · c clone · t related · esc close"
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.panel.render(width)
	}
}
