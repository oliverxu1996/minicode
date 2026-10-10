import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckpointStore, RewindRecorder, readFileState, resolveInWorkspace, restoreFiles, mutationTargets, type Checkpoint } from "../../src/session/checkpoint"
import { Compactor } from "../../src/context/compaction"
import { discardTurns, isLiveCheckpoint, liveCheckpoints, recordRewind, rewindSession, summarizeRange, turnIndexOf } from "../../src/session/rewind"
import { MiniCode } from "../../src/minicode"
import { Session } from "../../src/session/session"
import { FakeModel, textResponse, toolCallResponse } from "../support/testing"
import { agentFor } from "../support/loop"

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "minicode-rewind-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("rewind — checkpoint capture", () => {
  test("a run's file edit is captured at the turn boundary", async () => {
    const { dir, cleanup } = workspace()
    const { agent, cleanup: agentCleanup } = agentFor(
      new FakeModel([
        toolCallResponse([{ toolCallId: "c1", toolName: "write", input: { filePath: "src/new.ts", content: "hi\n" } }]),
        textResponse("done"),
      ]),
    )
    try {
      const session = agent.createSession(dir)
      await agent.run(session, "create the file", {})

      const store = new CheckpointStore(agent.sessionsDir)
      const checkpoints = await store.load(session.id)
      expect(checkpoints).toHaveLength(1)
      // One checkpoint for the whole turn, not one per iteration.
      expect(checkpoints[0]!.prompt).toBe("create the file")
      expect(checkpoints[0]!.messageIndex).toBe(0)
      // The file did not exist before the turn.
      expect(checkpoints[0]!.files.map(f => f.path)).toEqual(["src/new.ts"])
      expect(checkpoints[0]!.files[0]!.before.existed).toBe(false)
      expect(checkpoints[0]!.files[0]!.after?.content).toBe("hi\n")
    } finally {
      agentCleanup()
      cleanup()
    }
  })

  test("the recorder and the session are given exactly the same turn id", async () => {
    const { dir, cleanup } = workspace()
    const { agent, cleanup: agentCleanup } = agentFor(
      new FakeModel([
        toolCallResponse([{ toolCallId: "c1", toolName: "write", input: { filePath: "a.ts", content: "x\n" } }]),
        textResponse("done"),
      ]),
    )
    try {
      const session = agent.createSession(dir)
      await agent.run(session, "do the thing", {})

      const [checkpoint] = await new CheckpointStore(agent.sessionsDir).load(session.id)
      const user = session.messages.find(m => m.role === "user")
      // One id, minted once, given to both sides — so a checkpoint can always
      // find the turn it describes.
      expect(checkpoint!.turnId).toBeDefined()
      expect(checkpoint!.turnId).toBe((user as { turnId?: string }).turnId)
    } finally {
      agentCleanup()
      cleanup()
    }
  })

  test("a steer note is not a turn: it carries no identity", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = Session.create({ cwd: dir })
      session.pushUser("a task", "t1")
      // What the loop pushes when steering mid-turn.
      session.pushUser("also, do this")
      const ids = session.messages.filter(m => m.role === "user").map(m => (m as { turnId?: string }).turnId)
      expect(ids).toEqual(["t1", undefined])
      expect(turnIndexOf(session.messages, "t1")).toBe(0)
    } finally {
      cleanup()
    }
  })

  test("turn identity never reaches a provider-facing message", () => {
    const { dir, cleanup } = workspace()
    try {
      const session = Session.create({ cwd: dir })
      session.pushUser("a task", "t1")
      session.appendAssistant([{ type: "text", text: "working" }], {})

      const request = session.toRequestMessages()
      expect(request).toHaveLength(2)
      // Durable identity is agent-local: the projection is built from an
      // explicit field list, so nothing carries it to the model.
      expect(request.some(m => "turnId" in m)).toBe(false)
      expect(JSON.stringify(request)).not.toContain("t1")
    } finally {
      cleanup()
    }
  })

  test("only write/edit name a mutation target", () => {
    expect(mutationTargets("write", { filePath: "a.ts" })).toEqual(["a.ts"])
    expect(mutationTargets("edit", { filePath: "b.ts" })).toEqual(["b.ts"])
    // bash is an unrestricted shell: its writes cannot be attributed to a path.
    expect(mutationTargets("bash", { command: "rm -rf x" })).toEqual([])
    expect(mutationTargets("read", { filePath: "a.ts" })).toEqual([])
  })

  test("paths outside the workspace are never tracked", () => {
    expect(resolveInWorkspace("/work", "../etc/passwd")).toBeNull()
    expect(resolveInWorkspace("/work", "/etc/passwd")).toBeNull()
    expect(resolveInWorkspace("/work", "src/a.ts")).toBe("/work/src/a.ts")
  })

  test("a recorded checkpoint survives a fresh store (restart)", async () => {
    const { dir, cleanup } = workspace()
    try {
      writeFileSync(join(dir, "f.txt"), "before\n")
      const store = new CheckpointStore(join(dir, "sessions"))
      const recorder = new RewindRecorder(store)
      await recorder.beginTurn("s1", "do the thing", 3, "turn-1")
      await recorder.beforeTool("s1", dir, "write", { filePath: "f.txt" })
      writeFileSync(join(dir, "f.txt"), "after\n")
      await recorder.endTurn("s1", dir)

      // A brand-new store, as a restarted process would build.
      const reloaded = await new CheckpointStore(join(dir, "sessions")).load("s1")
      expect(reloaded).toHaveLength(1)
      expect(reloaded[0]!.prompt).toBe("do the thing")
      expect(reloaded[0]!.messageIndex).toBe(3)
      // The turn's identity is durable: it is the only thing that can still
      // connect this record to its turn after a restart.
      expect(reloaded[0]!.turnId).toBe("turn-1")
      expect(reloaded[0]!.files[0]!.before.content).toBe("before\n")
      expect(reloaded[0]!.files[0]!.after?.content).toBe("after\n")
    } finally {
      cleanup()
    }
  })

  test("a turn that changed nothing still records a checkpoint", async () => {
    const { dir, cleanup } = workspace()
    try {
      const store = new CheckpointStore(join(dir, "sessions"))
      const recorder = new RewindRecorder(store)
      await recorder.beginTurn("s1", "just a question", 0, "turn-q")
      await recorder.endTurn("s1", dir)

      const [checkpoint] = await store.load("s1")
      // The boundary is the record: a plain exchange is a valid rewind target
      // even though it has nothing of its own to restore.
      expect(checkpoint!.prompt).toBe("just a question")
      expect(checkpoint!.turnId).toBe("turn-q")
      expect(checkpoint!.files).toEqual([])
      expect(checkpoint!.shell).toBe(0)
    } finally {
      cleanup()
    }
  })

  test("two plain-text turns through the real run path are persisted and live", async () => {
    const { dir, cleanup } = workspace()
    const { agent, cleanup: agentCleanup } = agentFor(
      new FakeModel([textResponse("hello back"), textResponse("hi back")]),
    )
    try {
      const session = agent.createSession(dir)
      await agent.run(session, "Hello", {})
      await agent.run(session, "Hi", {})

      // Persisted: a restarted process reads both back, in order.
      const stored = await new CheckpointStore(agent.sessionsDir).load(session.id)
      expect(stored.map(c => c.prompt)).toEqual(["Hello", "Hi"])
      expect(stored.every(c => c.files.length === 0 && c.shell === 0)).toBe(true)

      // Live, and each anchored to its own turn — not to its neighbour's.
      const users = session.messages.filter(m => m.role === "user").map(m => (m as { turnId?: string }).turnId)
      expect(stored.map(c => c.turnId)).toEqual(users)
      expect(liveCheckpoints(stored, session.messages)).toHaveLength(2)
      expect(turnIndexOf(session.messages, stored[0]!.turnId)).toBe(0)
      expect(turnIndexOf(session.messages, stored[1]!.turnId)).toBe(2)
    } finally {
      agentCleanup()
      cleanup()
    }
  })

  test("a steer note does not create a checkpoint of its own", async () => {
    const { dir, cleanup } = workspace()
    try {
      const store = new CheckpointStore(join(dir, "sessions"))
      const recorder = new RewindRecorder(store)
      const session = Session.create({ cwd: dir })
      await recorder.beginTurn(session.id, "a task", 0, "t1")
      session.pushUser("a task", "t1")
      // What the loop pushes when steering mid-turn: no turn identity.
      session.pushUser("also, do this")
      await recorder.endTurn(session.id, dir)

      const stored = await store.load(session.id)
      expect(stored).toHaveLength(1) // one turn, one record
      expect(stored[0]!.turnId).toBe("t1")
      // The steer note is not a boundary anything can be rewound to.
      expect(liveCheckpoints(stored, session.messages)).toHaveLength(1)
      expect(turnIndexOf(session.messages, "t1")).toBe(0)
    } finally {
      cleanup()
    }
  })

  test("a request aborted before the turn opens records no checkpoint", async () => {
    const { dir, cleanup } = workspace()
    const { agent, cleanup: agentCleanup } = agentFor(new FakeModel([textResponse("never sent")]))
    try {
      const session = agent.createSession(dir)
      const controller = new AbortController()
      controller.abort()

      const result = await agent.run(session, "never starts", { signal: controller.signal })

      expect(result.aborted).toBe(true)
      expect(session.messages).toHaveLength(0) // the turn never began
      expect(await new CheckpointStore(agent.sessionsDir).load(session.id)).toEqual([])
    } finally {
      agentCleanup()
      cleanup()
    }
  })
})

describe("rewind — shell invocations", () => {
  /** A model that calls `bash` once per command, then answers. */
  function shellModel(commands: readonly string[]): FakeModel {
    return new FakeModel([
      ...commands.map((command, i) =>
        toolCallResponse([{ toolCallId: `sh${i}`, toolName: "bash", input: { command } }])),
      textResponse("done"),
    ])
  }

  test("a turn that runs a shell command records the invocation, and no file claim", async () => {
    const { dir, cleanup } = workspace()
    const { agent, cleanup: agentCleanup } = agentFor(shellModel(["true"]))
    try {
      const session = agent.createSession(dir)
      await agent.run(session, "run something", {})

      const checkpoints = await new CheckpointStore(agent.sessionsDir).load(session.id)
      // The bash-only turn gets a record at all: it is the case where the user
      // most needs to hear that rewinding undoes nothing the shell did.
      expect(checkpoints).toHaveLength(1)
      expect(checkpoints[0]!.shell).toBe(1)
      // A shell names no path, so nothing is claimed about what it touched.
      expect(checkpoints[0]!.files).toEqual([])
    } finally {
      agentCleanup()
      cleanup()
    }
  })

  test("a turn that runs no shell records zero invocations", async () => {
    const { dir, cleanup } = workspace()
    const { agent, cleanup: agentCleanup } = agentFor(
      new FakeModel([
        toolCallResponse([{ toolCallId: "c1", toolName: "write", input: { filePath: "a.ts", content: "x\n" } }]),
        textResponse("done"),
      ]),
    )
    try {
      const session = agent.createSession(dir)
      await agent.run(session, "write a file", {})
      const [checkpoint] = await new CheckpointStore(agent.sessionsDir).load(session.id)
      expect(checkpoint!.shell).toBe(0)
    } finally {
      agentCleanup()
      cleanup()
    }
  })

  test("a failed command is still recorded as an invocation", async () => {
    const { dir, cleanup } = workspace()
    const { agent, cleanup: agentCleanup } = agentFor(shellModel(["exit 7"]))
    try {
      const session = agent.createSession(dir)
      await agent.run(session, "fail at something", {})
      const [checkpoint] = await new CheckpointStore(agent.sessionsDir).load(session.id)
      // Recording the invocation does not assert it changed anything: a
      // non-zero exit still ran, and its effects are unknown either way.
      expect(checkpoint!.shell).toBe(1)
      expect(checkpoint!.files).toEqual([])
    } finally {
      agentCleanup()
      cleanup()
    }
  })

  test("an interrupted command is still recorded as an invocation", async () => {
    const { dir, cleanup } = workspace()
    // Bounded so the killed command cannot outlive the test: the run is
    // interrupted, not waited out.
    const { agent, cleanup: agentCleanup } = agentFor(shellModel(["touch started.marker && sleep 1"]))
    try {
      const session = agent.createSession(dir)
      const controller = new AbortController()
      const running = agent.run(session, "start something long", { signal: controller.signal })
      // Abort only once the command is provably running, so the interruption
      // lands mid-execution rather than before it.
      const marker = join(dir, "started.marker")
      for (let i = 0; i < 400 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 5))
      expect(existsSync(marker)).toBe(true)
      controller.abort()
      const result = await running
      expect(result.aborted).toBe(true)

      const [checkpoint] = await new CheckpointStore(agent.sessionsDir).load(session.id)
      // The command ran and was killed: an invocation with an unknown outcome,
      // recorded as such and making no claim about what it changed.
      expect(checkpoint!.shell).toBe(1)
      expect(checkpoint!.files).toEqual([])
    } finally {
      agentCleanup()
      cleanup()
    }
  })

  test("several invocations in one turn are counted once each", async () => {
    const { dir, cleanup } = workspace()
    const { agent, cleanup: agentCleanup } = agentFor(shellModel(["true", "true", "true"]))
    try {
      const session = agent.createSession(dir)
      await agent.run(session, "run three things", {})
      const [checkpoint] = await new CheckpointStore(agent.sessionsDir).load(session.id)
      expect(checkpoint!.shell).toBe(3)
      // One turn is one checkpoint, however many calls it made.
      expect(await new CheckpointStore(agent.sessionsDir).load(session.id)).toHaveLength(1)
    } finally {
      agentCleanup()
      cleanup()
    }
  })

  test("an invocation is counted before the command has any outcome", async () => {
    const { dir, cleanup } = workspace()
    try {
      const store = new CheckpointStore(join(dir, "sessions"))
      const recorder = new RewindRecorder(store)
      await recorder.beginTurn("s1", "p", 0, "turn-p")
      // No execution happens at all: the record must not depend on one.
      await recorder.beforeTool("s1", dir, "bash", { command: "rm -rf something" })
      await recorder.endTurn("s1", dir)

      const [checkpoint] = await store.load("s1")
      expect(checkpoint!.shell).toBe(1)
      expect(checkpoint!.files).toEqual([])
    } finally {
      cleanup()
    }
  })
})

describe("rewind — checkpoint lineage", () => {
  const checkpoint = (id: string, turnId: string | undefined, extra: Partial<Checkpoint> = {}): Checkpoint => ({
    id,
    prompt: `prompt of ${id}`,
    // Deliberately unrelated to where the turn really is: nothing may use it.
    messageIndex: 0,
    createdAt: 0,
    files: [],
    ...(turnId === undefined ? {} : { turnId }),
    ...extra,
  })

  /** One user turn per prompt, identified `t0`, `t1`, … at indices 0, 2, 4 … */
  function historyOf(cwd: string, prompts: readonly string[]): Session {
    const session = Session.create({ cwd })
    prompts.forEach((prompt, i) => {
      session.pushUser(prompt, `t${i}`)
      session.appendAssistant([{ type: "text", text: `re: ${prompt}` }], {})
    })
    return session
  }

  test("two turns with the same prompt text are different turns", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = historyOf(dir, ["continue", "continue", "continue"])
      // Identity, not text, decides where each turn is.
      expect(turnIndexOf(session.messages, "t0")).toBe(0)
      expect(turnIndexOf(session.messages, "t1")).toBe(2)
      expect(turnIndexOf(session.messages, "t2")).toBe(4)

      const outcome = await rewindSession(session, checkpoint("c1", "t1"), "conversation")
      expect(outcome.removedTurnIds).toEqual(["t1", "t2"])
      expect(outcome.removedMessages).toBe(4)
      expect(session.messages.map(m => (m.role === "user" ? m.turnId : null))).toEqual(["t0", null])
    } finally {
      cleanup()
    }
  })

  test("a new turn with the same prompt at the same index cannot revive a discarded checkpoint", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = historyOf(dir, ["continue"])
      // Its prompt is the same text the replacement turn will use — the exact
      // case a content anchor cannot tell apart.
      const removed = checkpoint("c0", "t0", { prompt: "continue" })
      const outcome = await rewindSession(session, removed, "conversation")
      expect(outcome.removedTurnIds).toEqual(["t0"])

      // The freed index is reused, with exactly the same prompt text.
      session.pushUser("continue", "t-new")
      session.appendAssistant([{ type: "text", text: "re: continue" }], {})
      expect(session.messages[0]!.role).toBe("user")
      expect((session.messages[0] as { content: string }).content).toBe(removed.prompt)

      // Text matches at the same index, identity does not: not live, not offered.
      expect(isLiveCheckpoint(removed, session.messages)).toBe(false)
      expect(liveCheckpoints([removed, checkpoint("c-new", "t-new")], session.messages).map(c => c.id)).toEqual(["c-new"])
    } finally {
      cleanup()
    }
  })

  test("the stored index decides nothing: neither eligibility nor the cut", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = historyOf(dir, ["first", "second", "third"])
      // Every record carries a nonsense index; identity is what counts.
      const last = checkpoint("c2", "t2")
      expect(last.messageIndex).toBe(0)
      expect(isLiveCheckpoint(last, session.messages)).toBe(true)

      const outcome = await rewindSession(session, last, "conversation")
      expect(outcome.removedTurnIds).toEqual(["t2"])
      // Cut where the turn really is (index 4), not where the record claims (0).
      expect(outcome.removedMessages).toBe(2)
      expect(turnIndexOf(session.messages, "t1")).toBe(2)
      expect(turnIndexOf(session.messages, "t2")).toBe(-1)
    } finally {
      cleanup()
    }
  })

  test("malformed metadata fails safely", async () => {
    const { dir, cleanup } = workspace()
    try {
      const store = new CheckpointStore(join(dir, "sessions"))
      const base = { prompt: "p", messageIndex: 0, createdAt: 0, files: [] }

      // A turn id that is not an identity: the record is dropped rather than
      // kept as a value that might match something.
      await store.save("s1", [
        { id: "bad", ...base, turnId: 42 } as unknown as Checkpoint,
        { id: "good", ...base, turnId: "t1" },
      ])
      expect((await store.load("s1")).map(c => c.id)).toEqual(["good"])

      // A shell count that is not a number is UNKNOWN, not zero: the record
      // stays usable for its turn, and reports that it does not know.
      await store.save("s2", [{ id: "c", ...base, turnId: "t1", shell: "many" } as unknown as Checkpoint])
      const [record] = await store.load("s2")
      expect(record!.shell).toBeUndefined()
      expect(record!.turnId).toBe("t1")
    } finally {
      cleanup()
    }
  })

  test("a checkpoint with no turn id is never live", () => {
    const { dir, cleanup } = workspace()
    try {
      const session = historyOf(dir, ["first"])
      expect(isLiveCheckpoint(checkpoint("legacy", undefined), session.messages)).toBe(false)
      expect(liveCheckpoints([checkpoint("legacy", undefined)], session.messages)).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("discarding tombstones exactly the removed turns, once", () => {
    const stored = [
      checkpoint("c0", "t0"),
      checkpoint("c1", "t1", { superseded: true }), // already counted by an earlier rewind
      checkpoint("c2", "t2"),
      checkpoint("c3", undefined), // never live; never attributable
    ]
    const advance = discardTurns(stored, ["t1", "t2"])
    expect(advance.discarded.map(c => c.id)).toEqual(["c2"])
    expect(advance.next.map(c => c.superseded === true)).toEqual([false, true, true, false])
    expect(advance.next.map(c => c.superseded === true ? null : c.id)).toEqual(["c0", null, null, "c3"])
  })

  test("summarizing above a checkpoint leaves the surviving turn live, at its new position", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = historyOf(dir, ["first", "second", "third"])
      const stored = [checkpoint("c0", "t0"), checkpoint("c1", "t1"), checkpoint("c2", "t2")]

      // [0, 4) becomes one summary message.
      const outcome = await summarizeRange(session, 0, 4, async () => "the first two turns, summarized")
      expect(outcome.removedTurnIds).toEqual(["t0", "t1"])

      const advance = discardTurns(stored, outcome.removedTurnIds)
      expect(advance.next.map(c => c.superseded === true)).toEqual([true, true, false])
      // The surviving turn kept its identity and moved up — found by identity,
      // with no shift arithmetic anywhere.
      expect(turnIndexOf(session.messages, "t2")).toBe(1)
      expect(liveCheckpoints(advance.next, session.messages).map(c => c.id)).toEqual(["c2"])
      // A user-role summary message is not a turn and cannot revive anything.
      expect(turnIndexOf(session.messages, undefined)).toBe(-1)
    } finally {
      cleanup()
    }
  })
})

describe("rewind — compaction", () => {
  const checkpoint = (id: string, turnId: string): Checkpoint =>
    ({ id, prompt: id, messageIndex: 0, createdAt: 0, turnId, files: [] })

  /**
   * A session whose three turns are identified `t1`–`t3`, with the first two
   * large enough that a small-window compaction summarizes them and keeps only
   * the last.
   */
  async function threeTurnSession(): Promise<{ session: Session; cleanup: () => void }> {
    const dir = mkdtempSync(join(tmpdir(), "minicode-compact-rewind-"))
    const session = new MiniCode({ sessionsDir: join(dir, "sessions") }).createSession(dir)
    for (const [turnId, text] of [["t1", "a".repeat(12_000)], ["t2", "b".repeat(12_000)], ["t3", "recent"]] as const) {
      session.pushUser(text, turnId)
      session.appendAssistant([{ type: "text", text: `did ${turnId}` }], {})
    }
    await session.checkpoint()
    return { session, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  const storedFor = (): Checkpoint[] => [checkpoint("c1", "t1"), checkpoint("c2", "t2"), checkpoint("c3", "t3")]

  test("a real compaction preserves retained turns and invalidates summarized ones", async () => {
    const { session, cleanup } = await threeTurnSession()
    try {
      const stored = storedFor()
      expect(turnIndexOf(session.messages, "t3")).toBe(4)

      const outcome = await new Compactor(new FakeModel([textResponse("summary")]), 1000).compact(session)
      expect(outcome.status).toBe("compacted")

      // The retained turn is still live, at the position it now occupies…
      expect(turnIndexOf(session.messages, "t3")).toBe(1)
      // …and the summarized turns are not, without any of them being guessed at.
      expect(turnIndexOf(session.messages, "t1")).toBe(-1)
      expect(turnIndexOf(session.messages, "t2")).toBe(-1)
      expect(liveCheckpoints(stored, session.messages).map(c => c.id)).toEqual(["c3"])
    } finally {
      cleanup()
    }
  })

  test("compaction then a reload yields the same live set", async () => {
    const { session, cleanup } = await threeTurnSession()
    try {
      const stored = storedFor()
      await new Compactor(new FakeModel([textResponse("summary")]), 1000).compact(session)

      const sessionsDir = join(session.cwd, "sessions")
      const reloaded = await new MiniCode({ sessionsDir }).loadSession(session.id)
      expect(liveCheckpoints(stored, reloaded.messages).map(c => c.id)).toEqual(["c3"])
      expect(turnIndexOf(reloaded.messages, "t3")).toBe(turnIndexOf(session.messages, "t3"))
    } finally {
      cleanup()
    }
  })

  test("repeated compaction and repeated rewinds never resurrect a checkpoint", async () => {
    const { session, cleanup } = await threeTurnSession()
    try {
      const stored = storedFor()
      const compactor = () => new Compactor(new FakeModel([textResponse("summary")]), 1000)
      await compactor().compact(session)
      await compactor().compact(session) // a second pass must not revive anything

      const live = () => liveCheckpoints(stored, session.messages).map(c => c.id)
      expect(live()).toEqual(["c3"])

      // Rewind to the surviving turn, then compact again: still nothing returns.
      const advance = discardTurns(stored, ["t3"])
      await rewindSession(session, checkpoint("c3", "t3"), "conversation")
      await compactor().compact(session)
      expect(liveCheckpoints(advance.next, session.messages)).toEqual([])
      expect(live()).toEqual([])
    } finally {
      cleanup()
    }
  })
})

describe("rewind — the session's shell warning", () => {
  const checkpoint = (shell: number): Checkpoint =>
    ({ id: `c${shell}`, prompt: "p", messageIndex: 0, createdAt: 0, files: [], shell })

  test("it accumulates, and a later rewind cannot clear what is still true", () => {
    const session = Session.create({ cwd: "/tmp" })
    recordRewind(session, [checkpoint(2), checkpoint(0)])
    expect(session.rewind).toEqual({ shellTurns: 1, shellCommands: 2, at: expect.any(Number) })

    // A second rewind discarding only non-shell turns must NOT erase the
    // warning: the commands the first one dropped are still un-undone.
    recordRewind(session, [checkpoint(0)])
    expect(session.rewind!.shellTurns).toBe(1)
    expect(session.rewind!.shellCommands).toBe(2)

    recordRewind(session, [checkpoint(3)])
    expect(session.rewind).toEqual({ shellTurns: 2, shellCommands: 5, at: expect.any(Number) })
  })

  test("a rewind that discarded nothing leaves the note untouched", () => {
    const session = Session.create({ cwd: "/tmp" })
    expect(session.rewind).toBeNull()
    recordRewind(session, [])
    expect(session.rewind).toBeNull()
  })

  test("the note round-trips through persistence", async () => {
    const { dir, cleanup } = workspace()
    try {
      const agent = new MiniCode({ sessionsDir: join(dir, "sessions") })
      const session = agent.createSession(dir)
      recordRewind(session, [checkpoint(2)])
      await session.checkpoint()

      const reloaded = await new MiniCode({ sessionsDir: join(dir, "sessions") }).loadSession(session.id)
      expect(reloaded.rewind).toEqual({ shellTurns: 1, shellCommands: 2, at: expect.any(Number) })
    } finally {
      cleanup()
    }
  })

  test("a missing, legacy or malformed note loads as null rather than failing", () => {
    const base = { version: 1, id: "s1", cwd: "/tmp", status: "idle", messages: [] }
    expect(Session.fromJSON(base).rewind).toBeNull() // written before the field existed
    expect(Session.fromJSON({ ...base, rewind: "nonsense" }).rewind).toBeNull()
    expect(Session.fromJSON({ ...base, rewind: { shellTurns: 1 } }).rewind).toBeNull()
    expect(Session.fromJSON({ ...base, rewind: { shellTurns: 1, shellCommands: 2, at: Number.NaN } }).rewind).toBeNull()
    expect(Session.fromJSON({ ...base, rewind: { shellTurns: 1, shellCommands: 2, at: 5 } }).rewind)
      .toEqual({ shellTurns: 1, shellCommands: 2, at: 5 })
  })
})

describe("rewind — file restoration", () => {
  test("restores a modified file, removes a created one, and reports both", async () => {
    const { dir, cleanup } = workspace()
    try {
      writeFileSync(join(dir, "kept.txt"), "original\n")
      const store = new CheckpointStore(join(dir, "sessions"))
      const recorder = new RewindRecorder(store)
      await recorder.beginTurn("s1", "edit two files", 0, "turn-edit")
      await recorder.beforeTool("s1", dir, "write", { filePath: "kept.txt" })
      await recorder.beforeTool("s1", dir, "write", { filePath: "made.txt" })
      writeFileSync(join(dir, "kept.txt"), "agent version\n")
      writeFileSync(join(dir, "made.txt"), "created\n")
      await recorder.endTurn("s1", dir)

      const [checkpoint] = await store.load("s1")
      const outcome = await restoreFiles(dir, checkpoint!.files)

      expect(readFileSync(join(dir, "kept.txt"), "utf-8")).toBe("original\n")
      expect(outcome.restored).toEqual(["kept.txt"])
      expect(outcome.removed).toEqual(["made.txt"])
      expect(outcome.failed).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("a file the user changed after the agent is skipped, not clobbered", async () => {
    const { dir, cleanup } = workspace()
    try {
      writeFileSync(join(dir, "f.txt"), "v0\n")
      const store = new CheckpointStore(join(dir, "sessions"))
      const recorder = new RewindRecorder(store)
      await recorder.beginTurn("s1", "p", 0, "turn-p")
      await recorder.beforeTool("s1", dir, "write", { filePath: "f.txt" })
      writeFileSync(join(dir, "f.txt"), "agent\n")
      await recorder.endTurn("s1", dir)

      writeFileSync(join(dir, "f.txt"), "user edited this\n") // after the agent

      const [checkpoint] = await store.load("s1")
      const outcome = await restoreFiles(dir, checkpoint!.files)

      expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("user edited this\n")
      expect(outcome.skipped).toHaveLength(1)
      expect(outcome.skipped[0]!.reason).toContain("changed after the agent")
    } finally {
      cleanup()
    }
  })

  test("refuses a symlink rather than writing through it", async () => {
    const { dir, cleanup } = workspace()
    try {
      const outside = join(dir, "..", `minicode-outside-${Date.now()}.txt`)
      writeFileSync(outside, "outside\n")
      symlinkSync(outside, join(dir, "link.txt"))
      const state = await readFileState(join(dir, "link.txt"))
      expect(state.unrestorable).toBe("symlink")

      const outcome = await restoreFiles(dir, [
        { path: "link.txt", before: { existed: true, content: "x", mode: null } },
      ])
      expect(outcome.failed).toHaveLength(1)
      expect(outcome.failed[0]!.reason).toContain("symlink")
      expect(readFileSync(outside, "utf-8")).toBe("outside\n") // untouched
      rmSync(outside, { force: true })
    } finally {
      cleanup()
    }
  })
})

describe("rewind — conversation restoration", () => {
  async function twoTurnSession(dir: string): Promise<Session> {
    // Created through the runtime so the durable sink is registered; a bare
    // `Session.create` has none and never writes.
    const session = new MiniCode({ sessionsDir: join(dir, "sessions") }).createSession(dir)
    session.pushUser("first", "t1")
    session.appendAssistant([{ type: "text", text: "a1" }], {})
    session.pushUser("second", "t2")
    session.appendAssistant([{ type: "text", text: "a2" }], {})
    await session.checkpoint()
    return session
  }

  test("removing later turns leaves the earlier ones and persists", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = await twoTurnSession(dir)
      const checkpoint = { id: "c", prompt: "second", messageIndex: 2, createdAt: 0, turnId: "t2", files: [] }
      const outcome = await rewindSession(session, checkpoint, "conversation")

      expect(outcome.removedMessages).toBe(2)
      expect(session.messages.map(m => (m.role === "user" ? m.content : m.role))).toEqual(["first", "assistant"])
      expect(outcome.prompt).toBe("second")

      // Persisted, so a reload cannot resurrect the removed turn.
      const reloaded = await new MiniCode({ sessionsDir: join(dir, "sessions") }).loadSession(session.id)
      expect(reloaded.messages).toHaveLength(2)
      expect(reloaded.messages.map(m => m.role)).toEqual(["user", "assistant"])
    } finally {
      cleanup()
    }
  })

  test("restoring the conversation leaves the files alone", async () => {
    const { dir, cleanup } = workspace()
    try {
      writeFileSync(join(dir, "f.txt"), "agent\n")
      const session = await twoTurnSession(dir)
      const checkpoint = { id: "c", prompt: "second", messageIndex: 2, createdAt: 0, turnId: "t2", files: [{ path: "f.txt", before: { existed: true, content: "before\n", mode: null } }] }
      const outcome = await rewindSession(session, checkpoint, "conversation")
      expect(outcome.files).toBeNull()
      expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("agent\n")
    } finally {
      cleanup()
    }
  })

  test("restoring code leaves the conversation alone", async () => {
    const { dir, cleanup } = workspace()
    try {
      writeFileSync(join(dir, "f.txt"), "agent\n")
      const session = await twoTurnSession(dir)
      const checkpoint = { id: "c", prompt: "second", messageIndex: 2, createdAt: 0, turnId: "t2", files: [{ path: "f.txt", before: { existed: true, content: "before\n", mode: null } }] }
      const outcome = await rewindSession(session, checkpoint, "code")
      expect(outcome.removedMessages).toBe(0)
      expect(session.messages).toHaveLength(4)
      expect(readFileSync(join(dir, "f.txt"), "utf-8")).toBe("before\n")
    } finally {
      cleanup()
    }
  })

  test("no orphaned ledger entry survives the rewind", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = Session.create({ cwd: dir })
      session.pushUser("first", "t1")
      const assistant = session.appendAssistant([{ type: "tool_call", toolCallId: "gone", toolName: "write", input: {} }], {})
      const toolMsg = session.toolResultMessageFor(assistant)
      session.appendToolResult(toolMsg, { toolCallId: "gone", toolName: "write", output: { type: "text", text: "ok" } })
      session.ledger.pending({ toolCallId: "gone", name: "write", input: {} })
      session.ledger.finished("gone", "succeeded")
      session.pushUser("second", "t2")

      // Rewind to before the second turn: the call is retained...
      await rewindSession(session, { id: "c", prompt: "second", messageIndex: 3, createdAt: 0, turnId: "t2", files: [] }, "conversation")
      expect(session.ledger.toJSON().map(e => e.toolCallId)).toEqual(["gone"])

      // ...and rewinding past it drops the entry with the message it belongs to.
      const second = Session.create({ cwd: dir })
      second.pushUser("first", "t1")
      const a = second.appendAssistant([{ type: "tool_call", toolCallId: "gone", toolName: "write", input: {} }], {})
      second.appendToolResult(second.toolResultMessageFor(a), { toolCallId: "gone", toolName: "write", output: { type: "text", text: "ok" } })
      second.ledger.pending({ toolCallId: "gone", name: "write", input: {} })
      second.ledger.finished("gone", "succeeded")
      second.pushUser("second", "t2")
      await rewindSession(second, { id: "c", prompt: "first", messageIndex: 0, createdAt: 0, turnId: "t1", files: [] }, "conversation")
      expect(second.messages).toHaveLength(0)
      expect(second.ledger.toJSON()).toEqual([])
      expect(second.ledger.hasUnfinished()).toBe(false)
    } finally {
      cleanup()
    }
  })
})

describe("rewind — summarization", () => {
  test("summarize from a checkpoint replaces that range and keeps the rest", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = Session.create({ cwd: dir })
      session.pushUser("first")
      session.appendAssistant([{ type: "text", text: "a1" }], {})
      session.pushUser("second")
      session.appendAssistant([{ type: "text", text: "a2" }], {})

      const outcome = await summarizeRange(session, 2, 4, async () => "the second turn, summarized")
      expect(outcome.replaced).toBe(2)
      expect(session.messages).toHaveLength(3)
      expect((session.messages[0] as { content: string }).content).toBe("first")
      expect((session.messages[2] as { content: string }).content).toContain("the second turn, summarized")
    } finally {
      cleanup()
    }
  })

  test("summarize up to a checkpoint replaces only the earlier range", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = Session.create({ cwd: dir })
      session.pushUser("first")
      session.appendAssistant([{ type: "text", text: "a1" }], {})
      session.pushUser("second")
      session.appendAssistant([{ type: "text", text: "a2" }], {})

      await summarizeRange(session, 0, 2, async () => "the first turn, summarized")
      expect(session.messages).toHaveLength(3)
      expect((session.messages[0] as { content: string }).content).toContain("the first turn, summarized")
      expect((session.messages[1] as { content: string }).content).toBe("second")
    } finally {
      cleanup()
    }
  })

  test("a range that would split a turn is refused", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = Session.create({ cwd: dir })
      session.pushUser("first")
      session.appendAssistant([{ type: "text", text: "a1" }], {})
      // Index 1 is an assistant message: summarising from there would separate
      // the tool-call pairing the provider requires.
      await expect(summarizeRange(session, 1, 2, async () => "x")).rejects.toThrow(/start at a user turn/)
      expect(session.messages).toHaveLength(2) // untouched
    } finally {
      cleanup()
    }
  })

  test("an empty summary leaves history untouched", async () => {
    const { dir, cleanup } = workspace()
    try {
      const session = Session.create({ cwd: dir })
      session.pushUser("first")
      await expect(summarizeRange(session, 0, 1, async () => "  ")).rejects.toThrow(/empty summary/)
      expect(session.messages).toHaveLength(1)
    } finally {
      cleanup()
    }
  })
})
