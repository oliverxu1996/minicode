/**
 * `/rewind` through the real TUI.
 *
 * These tests mount the actual `MiniCodeTui` against a mock terminal and drive
 * the real command, picker, and action-menu code paths — the selectors are
 * exercised, not reimplemented. File and history effects are read back from
 * the filesystem and the session, so a passing test means the operation
 * actually happened rather than that a handler was called.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Model, ModelEvent, ModelRequest, ModelResponse } from "@minicode/model"
import { MiniCode, type Session } from "@minicode/agent"
import type { Terminal } from "@minicode/tui"
import { MiniCodeTui } from "./app"
import { parseScreen } from "./view/testing"

/** A model that answers with one `write` call, then a plain reply. */
class WritingModel implements Model {
  readonly id = "w"
  readonly name = "Writer"
  readonly protocol = "openai" as const
  readonly model = "w"
  readonly limits = { contextWindow: 128000, maxOutputTokens: 8192 }
  /** file path → content to write on the first stream of each run. */
  writes: Array<{ filePath: string; content: string }> = []
  /** Shell commands to run, once the queued writes are used up. */
  commands: string[] = []
  private streams = 0
  async generate(): Promise<ModelResponse> {
    return { content: "summary text", toolCalls: [], finishReason: "stop" }
  }
  async *stream(_request: ModelRequest): AsyncIterable<ModelEvent> {
    this.streams += 1
    const pending = this.writes.shift()
    if (pending !== undefined) {
      yield { type: "tool_call", toolCall: { toolCallId: `c${this.streams}`, toolName: "write", input: pending } }
      yield { type: "finish", reason: "tool_call" }
      return
    }
    const command = this.commands.shift()
    if (command !== undefined) {
      yield { type: "tool_call", toolCall: { toolCallId: `c${this.streams}`, toolName: "bash", input: { command } } }
      yield { type: "finish", reason: "tool_call" }
      return
    }
    yield { type: "text_delta", text: "done" }
    // A provider reports usage; the footer's context gauge reads it.
    yield { type: "usage", usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 } }
    yield { type: "finish", reason: "stop" }
  }
}

interface Tty {
  readonly terminal: Terminal
  readonly writes: string[]
  feed(data: string): void
}

function createTerminal(columns = 100, rows = 30): Tty {
  const state = { columns, rows, send: undefined as ((d: string) => void) | undefined }
  const writes: string[] = []
  const terminal: Terminal = {
    start(onInput) {
      state.send = onInput
    },
    stop() {},
    async drainInput() {},
    write(data) {
      writes.push(data)
    },
    get columns() {
      return state.columns
    },
    get rows() {
      return state.rows
    },
    get kittyProtocolActive() {
      return false
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  }
  return { terminal, writes, feed: d => state.send?.(d) }
}

let root: string
let ws: string
let sessionsDir: string
let priorConfigDir: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-rewind-"))
  ws = join(root, "ws")
  sessionsDir = join(root, "sessions")
  mkdirSync(ws)
  mkdirSync(sessionsDir)
  mkdirSync(join(root, "config"))
  priorConfigDir = process.env.MINICODE_CONFIG_DIR
  process.env.MINICODE_CONFIG_DIR = join(root, "config")
})

afterEach(() => {
  if (priorConfigDir === undefined) delete process.env.MINICODE_CONFIG_DIR
  else process.env.MINICODE_CONFIG_DIR = priorConfigDir
  rmSync(root, { recursive: true, force: true })
})

interface Harness {
  readonly model: WritingModel
  readonly agent: MiniCode
  readonly app: MiniCodeTui
  readonly tty: Tty
  readonly sessionId: string
}

const flush = async (times = 8): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise(r => setTimeout(r, 0))
}

interface Turn {
  readonly prompt: string
  readonly write?: { filePath: string; content: string }
  /** A shell command this turn runs through the `bash` tool. */
  readonly bash?: string
}

/** The real TUI over a session that already has `turns` recorded runs. */
async function makeApp(turns: readonly Turn[], columns = 100): Promise<Harness> {
  const model = new WritingModel()
  const agent = new MiniCode({ sessionsDir, model })
  const session = agent.createSession(ws)
  for (const turn of turns) {
    model.writes = turn.write === undefined ? [] : [turn.write]
    model.commands = turn.bash === undefined ? [] : [turn.bash]
    await agent.run(session, turn.prompt, {})
  }
  return mount(agent, session, model, columns)
}

/** Mounts a fresh app over a session, as a restart would build. */
async function mount(agent: MiniCode, session: Session, model: WritingModel, columns = 100): Promise<Harness> {
  const tty = createTerminal(columns)
  const app = new MiniCodeTui({ agent, session, terminal: tty.terminal, label: ws })
  app.start()
  return { model, agent, app, tty, sessionId: session.id }
}

/** Remounts the same on-disk session in a new process-equivalent app. */
async function remount(h: Harness): Promise<Harness> {
  h.app.stop()
  const agent = new MiniCode({ sessionsDir, model: h.model })
  const session = await agent.loadSession(h.sessionId)
  return mount(agent, session, h.model)
}

/** The screen with runs of whitespace collapsed, for phrases that wrap. */
const flat = (text: string): string => text.replace(/\s+/g, " ")

/** Forces a frame and returns it as plain text rows. */
function screen(h: Harness): string {
  h.tty.writes.length = 0
  ;(h.app as unknown as { tui: { renderNow(force?: boolean): void } }).tui.renderNow(true)
  return parseScreen(h.tty.writes.join(""), 30).join("\n")
}

const ENTER = "\r"
const ESC = "\x1b"
const DOWN = "\x1b[B"
const UP = "\x1b[A"

/**
 * Clears the composer before typing a command.
 *
 * A rewound prompt is restored into the composer by design, so anything typed
 * next would append to it. This is test setup and deliberately does not go
 * through Ctrl+C: that key arms an exit, and a second press within 500ms
 * terminates the process — which would take the whole test run with it.
 */
async function clearComposer(h: Harness): Promise<void> {
  ;(h.app as unknown as { editor: { setText(text: string): void } }).editor.setText("")
  await flush()
}

/** Opens `/rewind` and waits for the picker. */
async function openRewind(h: Harness): Promise<void> {
  await clearComposer(h)
  h.tty.feed("/rewind")
  h.tty.feed(ENTER)
  await flush()
}

/** Runs `/rewind` down to `action` (1-based row in the action menu). */
async function rewindTo(h: Harness, checkpointRow: number, actionRow: number): Promise<void> {
  await openRewind(h)
  for (let i = 1; i < checkpointRow; i++) {
    h.tty.feed(DOWN)
    await flush()
  }
  h.tty.feed(ENTER)
  await flush()
  for (let i = 1; i < actionRow; i++) {
    h.tty.feed(DOWN)
    await flush()
  }
  h.tty.feed(ENTER)
  await flush(16)
}

const messages = (h: Harness): readonly unknown[] =>
  (h.app as unknown as { session: { messages: readonly unknown[] } }).session.messages

const composer = (h: Harness): string =>
  (h.app as unknown as { editor: { getText(): string } }).editor.getText()

describe("rewind — entry point and picker", () => {
  test("with no checkpoints it says so and opens no picker", async () => {
    const h = await makeApp([])
    await openRewind(h)
    expect(screen(h)).toContain("nothing to rewind to")
    expect(screen(h)).not.toContain("Rewind to")
  })

  test("it lists the recorded prompts", async () => {
    const h = await makeApp([
      { prompt: "first thing", write: { filePath: "a.txt", content: "A\n" } },
      { prompt: "second thing", write: { filePath: "b.txt", content: "B\n" } },
    ])
    await openRewind(h)
    const view = screen(h)
    expect(view).toContain("Rewind to")
    expect(view).toContain("first thing")
    expect(view).toContain("second thing")
  })

  test("selecting a checkpoint opens the action menu with all six actions", async () => {
    const h = await makeApp([{ prompt: "the turn", write: { filePath: "a.txt", content: "A\n" } }])
    await openRewind(h)
    h.tty.feed(ENTER)
    await flush()
    const view = screen(h)
    for (const label of [
      "Restore code and conversation",
      "Restore conversation",
      "Restore code",
      "Summarize from here",
      "Summarize up to here",
      "Cancel",
    ]) {
      expect(view).toContain(label)
    }
  })

  test("Escape at the picker changes nothing", async () => {
    const h = await makeApp([{ prompt: "the turn", write: { filePath: "a.txt", content: "A\n" } }])
    const before = messages(h).length
    await openRewind(h)
    h.tty.feed(ESC)
    await flush()
    expect(messages(h).length).toBe(before)
    expect(readFileSync(join(ws, "a.txt"), "utf-8")).toBe("A\n")
    expect(composer(h)).toBe("")
  })

  test("Cancel at the action menu changes nothing", async () => {
    const h = await makeApp([{ prompt: "the turn", write: { filePath: "a.txt", content: "A\n" } }])
    const before = messages(h).length
    await rewindTo(h, 1, 6) // Cancel is the sixth row
    expect(messages(h).length).toBe(before)
    expect(readFileSync(join(ws, "a.txt"), "utf-8")).toBe("A\n")
    expect(composer(h)).toBe("")
  })
})

describe("rewind — actions", () => {
  test("restore code and conversation undoes the turn and restores the prompt", async () => {
    const h = await makeApp([
      { prompt: "keep this", write: { filePath: "keep.txt", content: "K\n" } },
      { prompt: "undo this", write: { filePath: "undo.txt", content: "U\n" } },
    ])
    expect(existsSync(join(ws, "undo.txt"))).toBe(true)

    await rewindTo(h, 1, 1) // newest checkpoint, "Restore code and conversation"

    expect(existsSync(join(ws, "undo.txt"))).toBe(false) // the agent created it
    expect(readFileSync(join(ws, "keep.txt"), "utf-8")).toBe("K\n") // untouched
    expect(composer(h)).toBe("undo this") // ready to edit and resend
    // The rewound turn is gone from history.
    const roles = (messages(h) as Array<{ role: string }>).map(m => m.role)
    expect(roles.filter(r => r === "user")).toHaveLength(1)
  })

  test("restore conversation leaves the files alone", async () => {
    const h = await makeApp([{ prompt: "undo this", write: { filePath: "undo.txt", content: "U\n" } }])
    await rewindTo(h, 1, 2)
    expect(existsSync(join(ws, "undo.txt"))).toBe(true) // file kept
    expect(composer(h)).toBe("undo this")
    expect(messages(h)).toHaveLength(0)
  })

  test("restore code leaves the conversation alone", async () => {
    const h = await makeApp([{ prompt: "undo this", write: { filePath: "undo.txt", content: "U\n" } }])
    const before = messages(h).length
    await rewindTo(h, 1, 3)
    expect(existsSync(join(ws, "undo.txt"))).toBe(false) // file undone
    expect(messages(h).length).toBe(before) // conversation kept
    expect(composer(h)).toBe("")
  })

  test("summarize from the checkpoint replaces that turn and keeps earlier ones", async () => {
    const h = await makeApp([
      { prompt: "first", write: { filePath: "a.txt", content: "A\n" } },
      { prompt: "second", write: { filePath: "b.txt", content: "B\n" } },
    ])
    await rewindTo(h, 1, 4) // "Summarize from here" on the newest checkpoint

    const texts = (messages(h) as Array<{ role: string; content: unknown }>).map(m =>
      typeof m.content === "string" ? m.content : "")
    expect(texts.some(t => t.includes("Summary of earlier conversation"))).toBe(true)
    expect(texts.some(t => t.includes("first"))).toBe(true) // earlier turn preserved
    // Summarizing never touches the files.
    expect(existsSync(join(ws, "b.txt"))).toBe(true)
  })

  test("summarize up to the checkpoint keeps the checkpoint's own turn", async () => {
    const h = await makeApp([
      { prompt: "first", write: { filePath: "a.txt", content: "A\n" } },
      { prompt: "second", write: { filePath: "b.txt", content: "B\n" } },
    ])
    await rewindTo(h, 1, 5) // "Summarize up to here" on the newest checkpoint

    const texts = (messages(h) as Array<{ role: string; content: unknown }>).map(m =>
      typeof m.content === "string" ? m.content : "")
    expect(texts.some(t => t.includes("Summary of earlier conversation"))).toBe(true)
    expect(texts.some(t => t.includes("second"))).toBe(true) // kept verbatim
    expect(existsSync(join(ws, "a.txt"))).toBe(true)
  })
})

describe("rewind — partial and unsafe restoration", () => {
  test("a file the user changed after the agent is reported, not overwritten", async () => {
    const h = await makeApp([{ prompt: "the turn", write: { filePath: "f.txt", content: "agent\n" } }])
    writeFileSync(join(ws, "f.txt"), "user edit\n") // after the turn

    await rewindTo(h, 1, 1)

    expect(readFileSync(join(ws, "f.txt"), "utf-8")).toBe("user edit\n") // preserved
    const view = screen(h)
    expect(view).toContain("skipped")
    expect(view).toContain("changed after the agent")
  })

  test("a partial restore never reads as a complete success", async () => {
    const h = await makeApp([{ prompt: "the turn", write: { filePath: "f.txt", content: "agent\n" } }])
    writeFileSync(join(ws, "f.txt"), "user edit\n")

    await rewindTo(h, 1, 1)
    const view = screen(h)
    // The result names what happened and never claims a full tree restore.
    expect(view).toContain("only files the agent") // the notice wraps
    expect(view).not.toContain("restored 1 file(s)")
  })

  test("the TUI stays usable after a partial restore", async () => {
    const h = await makeApp([{ prompt: "the turn", write: { filePath: "f.txt", content: "agent\n" } }])
    writeFileSync(join(ws, "f.txt"), "user edit\n")
    await rewindTo(h, 1, 1)

    // A second command still works: the app did not wedge.
    await clearComposer(h)
    h.tty.feed("/help")
    h.tty.feed(ENTER)
    await flush()
    expect(screen(h)).toContain("Commands:")
  })

  test("rewind is refused while a run is active", async () => {
    const h = await makeApp([{ prompt: "the turn", write: { filePath: "f.txt", content: "agent\n" } }])
    ;(h.app as unknown as { running: boolean }).running = true
    await openRewind(h)
    expect(screen(h)).toContain("cannot rewind")
    ;(h.app as unknown as { running: boolean }).running = false
  })
})

describe("rewind — state consistency", () => {
  test("a rewound session does not resurrect removed turns after reload", async () => {
    const h = await makeApp([{ prompt: "gone", write: { filePath: "g.txt", content: "G\n" } }])
    await rewindTo(h, 1, 2) // conversation only

    const reloaded = await new MiniCode({ sessionsDir }).loadSession(h.sessionId)
    expect(reloaded.messages).toHaveLength(0)
  })

  test("no orphaned ledger entry survives a rewind", async () => {
    const h = await makeApp([{ prompt: "gone", write: { filePath: "g.txt", content: "G\n" } }])
    await rewindTo(h, 1, 2)
    const ledger = (h.app as unknown as { session: { ledger: { toJSON(): unknown[]; hasUnfinished(): boolean } } }).session.ledger
    expect(ledger.toJSON()).toEqual([])
    expect(ledger.hasUnfinished()).toBe(false)
  })

  test("a rewind can be performed twice without corrupting the session", async () => {
    const h = await makeApp([
      { prompt: "first", write: { filePath: "a.txt", content: "A\n" } },
      { prompt: "second", write: { filePath: "b.txt", content: "B\n" } },
    ])
    await rewindTo(h, 1, 2) // drop "second", conversation only

    const stillThere = (messages(h) as Array<{ role: string }>).filter(m => m.role === "user").length
    expect(stillThere).toBe(1)

    // The remaining checkpoint is still usable.
    await rewindTo(h, 1, 3) // restore code only
    expect(existsSync(join(ws, "a.txt"))).toBe(false)
  })
})

describe("rewind — accounting and context", () => {
  test("the context gauge stops describing the discarded conversation", async () => {
    // The run is driven through the TUI, so the footer's reading is genuine.
    const h = await makeApp([])
    h.model.writes = [{ filePath: "g.txt", content: "G\n" }]
    h.tty.feed("do the thing")
    h.tty.feed(ENTER)
    await flush(24)

    const displayOf = (): { lastCallUsage: unknown; runRequests: number } =>
      (h.app as unknown as { display: { lastCallUsage: unknown; runRequests: number } }).display
    expect(displayOf().lastCallUsage).toBeDefined() // a real reading from that run
    const requestsBefore = displayOf().runRequests
    expect(requestsBefore).toBeGreaterThan(0)

    await rewindTo(h, 1, 2) // conversation-only

    // The stale reading is gone, so the gauge cannot present the pre-rewind
    // conversation size as the current one...
    expect(displayOf().lastCallUsage).toBeUndefined()
    // ...while the genuine execution history is NOT erased.
    expect(displayOf().runRequests).toBe(requestsBefore)
    expect(screen(h)).toContain("Context —")
  })

  test("the run figures are kept, and labelled as predating the rewind", async () => {
    const h = await makeApp([{ prompt: "do the thing", write: { filePath: "g.txt", content: "G\n" } }], 120)
    await rewindTo(h, 1, 2) // conversation only

    const view = screen(h)
    // Both facts are stated plainly: the number is gone, and why.
    expect(view).toContain("Context — unknown after rewind")
    // The figures are genuine execution history: unadjusted, relabelled.
    expect(view).toContain("last run (before rewind)")
    expect(view).toContain("req")
  })

  test("a reloaded session reports its recorded run instead of 'no run yet'", async () => {
    const h = await makeApp([{ prompt: "did work", write: { filePath: "a.txt", content: "A\n" } }])
    const reloaded = await remount(h)

    const view = screen(reloaded)
    expect(view).not.toContain("no run yet")
    expect(view).toContain("last run")
    // The context reading is not persisted and is not reconstructed from
    // retained messages, so it is unknown — and reports itself as unknown
    // rather than as a figure nothing measured.
    expect(view).toContain("Context —")
  })

  test("switching sessions carries over neither figures nor warning", async () => {
    const h = await makeApp([{ prompt: "a shell turn", bash: "true" }])
    await rewindTo(h, 1, 1)
    expect(screen(h)).toContain("not undone")

    // A second session in the same workspace, with a run of its own.
    const other = h.agent.createSession(ws)
    h.model.writes = []
    h.model.commands = []
    await h.agent.run(other, "the other session's work", {})

    await clearComposer(h)
    h.tty.feed("/session")
    h.tty.feed(ENTER)
    await flush(12)
    // The manager opens on the current session, which lists last; the only
    // other session in this workspace is one row up.
    h.tty.feed(UP)
    await flush()
    h.tty.feed(ENTER)
    await flush(16)

    const view = screen(h)
    // The warning belonged to the session it was recorded on...
    expect(view).not.toContain("not undone")
    // ...and the transcript is the switched-to session's own.
    expect(view).toContain("the other session's work")
  })
})

describe("rewind — shell side effects in the TUI", () => {
  test("a rewound shell turn warns, and the warning persists", async () => {
    const h = await makeApp([{ prompt: "run the tests", bash: "true" }])
    expect(screen(h)).not.toContain("not undone")

    await rewindTo(h, 1, 1) // newest checkpoint, restore code and conversation

    // The transcript states what the shell did: it ran, and that is all that
    // is known — nothing is claimed about its effects.
    const view = flat(screen(h))
    expect(view).toContain("shell: NOT reversed")
    expect(view).toContain("1 command ran in 1 discarded turn")
    expect(view).toContain("may have written files, left processes running")

    // The warning is chrome, not scrollback: unrelated work does not remove it.
    await clearComposer(h)
    h.tty.feed("/help")
    h.tty.feed(ENTER)
    await flush()
    expect(screen(h)).toContain("Commands:")
    expect(flat(screen(h))).toContain("1 shell command in 1 rewound turn not undone")
  })

  test("the warning survives a reload", async () => {
    const h = await makeApp([{ prompt: "run the tests", bash: "true" }])
    await rewindTo(h, 1, 1)
    const reloaded = await remount(h)
    expect(screen(reloaded)).toContain("1 shell command in 1 rewound turn not undone")
  })

  test("summarizing a shell turn away warns as well, and keeps the files", async () => {
    const h = await makeApp([
      { prompt: "first", write: { filePath: "a.txt", content: "A\n" } },
      { prompt: "shell turn", bash: "true" },
    ])
    await rewindTo(h, 1, 4) // "shell turn", the fourth action: summarize from here

    const view = flat(screen(h))
    // The record of what the shell did is gone from the transcript too, so the
    // warning is if anything more warranted.
    expect(view).toContain("shell: NOT reversed")
    expect(view).toContain("1 shell command in 1 rewound turn not undone")
    expect(existsSync(join(ws, "a.txt"))).toBe(true) // summarizing never touches files
  })

  test("a rewind that discarded no shell turn says so instead of warning", async () => {
    const h = await makeApp([{ prompt: "write it", write: { filePath: "a.txt", content: "A\n" } }])
    await rewindTo(h, 1, 1)
    const view = screen(h)
    expect(view).toContain("shell: none invoked by the discarded turns")
    expect(view).not.toContain("not undone")
  })

  test("a shell-only turn is offered, and rewinding it removes the turn", async () => {
    const h = await makeApp([{ prompt: "just run it", bash: "true" }])
    await openRewind(h)
    // The row reports the invocation even though the turn named no file.
    expect(screen(h)).toContain("1 shell command")

    h.tty.feed(ENTER) // the checkpoint
    await flush()
    h.tty.feed(ENTER) // the first action: restore code and conversation
    await flush(16)

    expect(messages(h)).toHaveLength(0)
    expect(composer(h)).toBe("just run it")
    expect(screen(h)).toContain("not undone")
  })

  test("a new turn reusing a freed index does not resurrect a stale checkpoint", async () => {
    const h = await makeApp([
      { prompt: "first", write: { filePath: "a.txt", content: "A\n" } },
      { prompt: "second", bash: "true" },
      { prompt: "third", write: { filePath: "c.txt", content: "C\n" } },
    ])
    // Rows are newest-first: "second" is row 2. Conversation only, so the
    // files stay where they are.
    await rewindTo(h, 2, 2)
    expect(screen(h)).toContain("1 shell command in 1 rewound turn not undone")

    // A new turn takes over the index the discarded turn used.
    await clearComposer(h)
    h.model.writes = [{ filePath: "d.txt", content: "D\n" }]
    h.tty.feed("fourth")
    h.tty.feed(ENTER)
    await flush(24)

    await openRewind(h)
    const view = screen(h)
    expect(view).toContain("first") // above the rewind point: still usable
    expect(view).toContain("fourth") // the new turn at the reused index
    expect(view).not.toContain("second") // the discarded turn's record is not offered
    expect(view).not.toContain("third")
    h.tty.feed(ESC)
    await flush()
  })

  test("a retained turn's shell commands are not attributed to the warning", async () => {
    const h = await makeApp([
      { prompt: "kept shell turn", bash: "true" }, // retained: its command stays out of the count
      { prompt: "discarded shell turn", bash: "true" },
      { prompt: "later", write: { filePath: "b.txt", content: "B\n" } },
    ])
    await rewindTo(h, 2, 2)

    const view = flat(screen(h))
    // One command, from the one discarded turn — not two.
    expect(view).toContain("1 command ran in 1 discarded turn")
    expect(view).toContain("1 shell command in 1 rewound turn not undone")
  })

  test("every discarded shell turn is counted", async () => {
    const h = await makeApp([
      { prompt: "first", bash: "true" },
      { prompt: "second", bash: "true" },
    ])
    // Rows are newest-first, so the oldest turn is the last row — rewinding to
    // it discards both turns.
    await rewindTo(h, 2, 2)

    const view = flat(screen(h))
    expect(view).toContain("2 commands ran in 2 discarded turns")
    expect(view).toContain("2 shell commands in 2 rewound turns not undone")
  })

  test("a new turn with the same prompt at the same index is not the removed turn", async () => {
    const h = await makeApp([
      { prompt: "kept", write: { filePath: "a.txt", content: "A\n" } },
      { prompt: "repeat", bash: "true" },
    ])
    await rewindTo(h, 1, 2) // "repeat", conversation only
    expect(flat(screen(h))).toContain("1 shell command in 1 rewound turn not undone")

    // The same prompt, at the same index: only identity separates them.
    await clearComposer(h)
    h.model.writes = [{ filePath: "d.txt", content: "D\n" }]
    h.tty.feed("repeat")
    h.tty.feed(ENTER)
    await flush(24)

    await openRewind(h)
    const view = flat(screen(h))
    // The offered "repeat" is the new turn — the one that wrote a file — not
    // the discarded one that ran a command.
    const picker = view.slice(view.indexOf("Rewind to"))
    expect(picker).toContain("repeat 1 file")
    expect(picker).not.toContain("shell")
    h.tty.feed(ENTER)
    await flush()
    h.tty.feed(ENTER) // restore conversation
    await flush(16)

    // And nothing of the old turn clings to it: the warning did not grow.
    expect(flat(screen(h))).toContain("1 shell command in 1 rewound turn not undone")
  })

  test("records written before turn identity are not offered", async () => {
    const h = await makeApp([{ prompt: "the turn", write: { filePath: "a.txt", content: "A\n" } }])
    const path = join(sessionsDir, `${h.sessionId}.checkpoints.json`)
    const [record] = JSON.parse(readFileSync(path, "utf-8")) as Array<Record<string, unknown>>
    delete record!.turnId
    delete record!.shell
    writeFileSync(path, JSON.stringify([record]))

    await openRewind(h)
    const view = flat(screen(h))
    expect(view).toContain("nothing to rewind to")
    expect(view).toContain("no longer match this conversation")
  })

  test("a checkpoint record that cannot be saved is reported, and the rewind as applied", async () => {
    const h = await makeApp([{ prompt: "the turn", write: { filePath: "a.txt", content: "A\n" } }])
    // The sidecar write is made to fail on its own: it shares a directory with
    // the session snapshot, so no filesystem permission can fail one without
    // failing the other, and the point here is the reporting, not the IO.
    const store = (h.app as unknown as { checkpointStore: { save(id: string, records: unknown): Promise<void> } }).checkpointStore
    store.save = async () => {
      throw new Error("disk full")
    }

    await rewindTo(h, 1, 1)

    const view = flat(screen(h))
    // The history change really happened, and is reported as having happened…
    expect(messages(h)).toHaveLength(0)
    expect(view).toContain("rewound")
    // …while the part that failed is named as failed, not claimed as done.
    expect(view).toContain("checkpoint record could not be saved")
    expect(view).toContain("disk full")
    expect(view).toContain("later rewinds may still offer these turns")
  })

  test("only discarded turns are counted, and a later rewind cannot clear the warning", async () => {
    const h = await makeApp([
      { prompt: "kept", write: { filePath: "a.txt", content: "A\n" } }, // no shell, retained
      { prompt: "shell turn", bash: "true" },
      { prompt: "later", write: { filePath: "b.txt", content: "B\n" } },
    ])
    // "shell turn" is row 2; discarding it and "later" leaves "kept" alone,
    // so its (nonexistent) shell activity must not be attributed here.
    await rewindTo(h, 2, 2)
    expect(screen(h)).toContain("1 shell command in 1 rewound turn not undone")

    // A second rewind discards only "kept" — which ran no shell. The warning
    // must not grow, and must not be cleared: the command is still un-undone.
    await rewindTo(h, 1, 2)
    const view = screen(h)
    expect(view).toContain("shell: none invoked by the discarded turns")
    expect(view).toContain("1 shell command in 1 rewound turn not undone")
  })
})

describe("rewind — plain-text turns", () => {
  test("a prompt that called no tool is offered, and rewinding it restores the prompt", async () => {
    const h = await makeApp([])
    h.tty.feed("just chatting")
    h.tty.feed(ENTER)
    await flush(24)

    await openRewind(h)
    const view = flat(screen(h))
    // The row is the turn's own prompt, and names no file count: an ordinary
    // conversation turn has no file result to report.
    const picker = view.slice(view.indexOf("Rewind to"))
    // The row reads as prompt then time — with no empty file count wedged in.
    expect(picker).toMatch(/just chatting\s+\d{1,2}:\d{2}:\d{2}/)
    expect(picker).not.toContain("0 files")

    h.tty.feed(ENTER) // the checkpoint
    await flush()
    h.tty.feed(ENTER) // restore code and conversation
    await flush(16)

    // The documented semantics: the turn is gone and its prompt is back.
    expect(messages(h)).toHaveLength(0)
    expect(composer(h)).toBe("just chatting")

    const after = flat(screen(h))
    // Nothing was tracked, so there is nothing to restore and nothing to
    // disclaim — not the tracking note standing on its own.
    expect(after).toContain("files unchanged")
    expect(after).not.toContain("only files the agent")
  })
})
