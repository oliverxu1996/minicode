/**
 * Work 3 — Session checkpoint ownership (runtime half).
 *
 * The invariant under test throughout: after a successful lifecycle mutation
 * or run checkpoint returns, the resulting session is ALREADY durable. Every
 * test therefore discards the in-memory object and reloads from disk through a
 * fresh runtime, because that is the only way to tell "durable" from "still in
 * memory".
 *
 * The command-driven lifecycle tests (/fork, /clone, /import) live with the
 * application in `@minicode/cli`; this file covers the runtime mechanisms:
 * compaction durability and run recovery ordering.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Compactor } from "../../src/context/compaction"
import { runTask } from "../../src/loop/run"
import { MiniCode } from "../../src/minicode"
import { Session } from "../../src/session/session"
import { FakeModel, textResponse, toolCallResponse } from "../support/testing"
import type { Tool } from "../../src/tools"

interface Fixture {
  readonly dir: string
  readonly sessionsDir: string
  readonly agent: MiniCode
  /** A second runtime over the same store — "the process restarted". */
  reload(id: string): Promise<Session>
  cleanup(): void
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "minicode-lifecycle-"))
  const sessionsDir = join(dir, "sessions")
  const agent = new MiniCode({ sessionsDir, model: new FakeModel([textResponse("ok")]) })
  return {
    dir,
    sessionsDir,
    agent,
    reload: async (id: string): Promise<Session> =>
      await new MiniCode({ sessionsDir }).loadSession(id),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe("session lifecycle durability (Work 3)", () => {
  test("AC4 — /compact is durable when compaction returns", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)
    // A compactable region: an older turn large enough that the preserved tail
    // stops before it, plus a trailing turn so the last message is not a user.
    session.pushUser("x".repeat(12_000))
    session.pushUser("y".repeat(4_000))
    session.appendAssistant([{ type: "text", text: "working" }], {})

    const outcome = await new Compactor(new FakeModel([textResponse("summary")]), 1000).compact(session)
    expect(outcome.status).toBe("compacted")

    const reloaded = await f.reload(session.id)
    const first = (reloaded.messages[0] as { content: string }).content
    expect(first).toContain("[Compacted conversation summary]")
    f.cleanup()
  })
})

describe("run recovery ordering is unchanged (Work 3)", () => {
  test("AC5 — the pending ledger entry is durable BEFORE the tool executes", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)

    // The probe inspects the durable session while it is itself running. If an
    // interruption at this instant could not be reconciled, this is where it
    // would show: the ledger would not yet hold the in-flight call.
    let duringTool: { hasUnfinished: boolean; status: string; entries: number } | null = null
    const probe: Tool = {
      description: "inspects the durable session from inside a tool call",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const reloaded = await f.reload(session.id)
        duringTool = {
          hasUnfinished: reloaded.ledger.hasUnfinished(),
          status: reloaded.status,
          entries: reloaded.ledger.all.length,
        }
        return { ok: true, data: "probed" }
      },
    }

    await runTask({
      session,
      model: new FakeModel([
        toolCallResponse([{ toolCallId: "c1", toolName: "probe", input: {} }]),
        textResponse("done"),
      ]),
      task: "probe the durable session",
      tools: new Map([["probe", probe]]),
    })

    // The recovery contract: an interruption during tool execution leaves a
    // session the next load can reconcile. The persisted status is "running";
    // loading it converts that to "interrupted", which is exactly the state
    // recovery keys on.
    expect(duringTool).not.toBeNull()
    expect(duringTool!.hasUnfinished).toBe(true)
    expect(duringTool!.status).toBe("interrupted")
    expect(duringTool!.entries).toBe(1)
    f.cleanup()
  })

  test("AC5 — an interrupted run still reconciles on the next load", async () => {
    const f = fixture()
    const session = f.agent.createSession(f.dir)

    // Leave an in-flight invocation behind exactly as an interruption would:
    // a run began (persisting 'running') but never finished.
    await session.beginRun({
      id: "test-model",
      name: "Test Model",
      protocol: "openai",
      model: "test-model",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    })
    session.ledger.pending({ toolCallId: "c1", name: "bash", input: { command: "echo hi" } })
    await session.checkpoint()

    const reloaded = await f.reload(session.id)
    expect(reloaded.status).toBe("interrupted")
    expect(reloaded.ledger.hasUnfinished()).toBe(true)

    // Reconciliation produces the same outcome the crash contract promises:
    // an unknown-outcome result the model can see, never a fabricated success.
    const report = await reloaded.recover()
    expect(report.reissued.length + report.unknownOutcome.length).toBeGreaterThan(0)
    expect(reloaded.ledger.hasUnfinished()).toBe(false)
    f.cleanup()
  })
})
