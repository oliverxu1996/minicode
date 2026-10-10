/**
 * ToolLedger: the durable tool-invocation state machine and the read-only
 * boundary that keeps its internals from escaping.
 *
 * The read-boundary test is type-level: its `@ts-expect-error` lines must FAIL
 * to compile, which `bun run typecheck` enforces. The closure is never invoked.
 */
import { describe, expect, test } from "bun:test"
import { ToolLedger, toolDurationMs } from "../../src/session/ledger"
import { Session } from "../../src/session/session"

/** Never invoked: its body exists only so `tsc` checks the read-only boundary. */
function typeOnly(fn: () => void): void {
  void fn
}

function sess(): Session {
  const session = Session.create({ cwd: "/tmp/loongcode-boundary-test" })
  session.onCheckpoint(async () => {})
  return session
}

describe("ToolLedger (AC7)", () => {
  test("transitions pending → running → succeeded", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: { command: "x" } })
    expect(ledger.get("c1")?.status).toBe("pending")
    ledger.running("c1")
    expect(ledger.get("c1")?.status).toBe("running")
    ledger.finished("c1", "succeeded")
    expect(ledger.get("c1")?.status).toBe("succeeded")
  })

  test("illegal transitions throw", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} })
    // Finalizing from `pending` is legal (gate outcomes)…
    ledger.finished("c1", "succeeded")
    // …but a terminal state is immutable.
    expect(() => ledger.running("c1")).toThrow()
    expect(() => ledger.finished("c1", "failed")).toThrow()
    expect(() => ledger.reissue("c1")).toThrow()
  })

  test("duplicate terminal ids error; duplicate pending ids are reissue no-ops", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} })
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} }) // reissue no-op
    expect(ledger.get("c1")?.status).toBe("pending")
    ledger.finished("c1", "failed")
    expect(() => ledger.pending({ toolCallId: "c1", name: "edit", input: {} })).toThrow()
  })
})

describe("Tool duration (O3)", () => {
  // Derived from the ledger's own timestamps, which stay the durable source.
  // A duration the runtime has no evidence for must stay unknown — never 0.

  test("a completed invocation reports the interval it actually spanned", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} })
    ledger.running("c1", { startedAt: 1_000 })
    ledger.finished("c1", "succeeded", { finishedAt: 1_450 })

    expect(toolDurationMs(ledger.get("c1")!)).toBe(450)
  })

  test("an invocation that never started reports no duration", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} })
    ledger.finished("c1", "failed", { finishedAt: 1_450 })

    expect(ledger.get("c1")!.startedAt).toBeUndefined()
    expect(toolDurationMs(ledger.get("c1")!)).toBeUndefined()
  })

  test("an invocation that never finished reports no duration", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: {} })
    ledger.running("c1", { startedAt: 1_000 })

    expect(toolDurationMs(ledger.get("c1")!)).toBeUndefined()
  })

  test("a reissued invocation is not measured across the gap", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "read", input: {} })
    ledger.running("c1", { startedAt: 1_000 })
    ledger.reissue("c1", "previous outcome unknown; idempotent tool reissued after restart")

    // Reissue erases the interval: nothing pairs the stale start with a later
    // end, so the gap is not reported as execution time.
    expect(toolDurationMs(ledger.get("c1")!)).toBeUndefined()

    // The re-execution reports its own interval, not the one spanning the gap.
    ledger.running("c1", { startedAt: 5_000 })
    ledger.finished("c1", "succeeded", { finishedAt: 5_450 })
    expect(toolDurationMs(ledger.get("c1")!)).toBe(450)
  })
})

describe("F1 — ToolLedger external read boundary", () => {
  test("the collection and its entries are read-only through the public API", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: { command: "x" } })

    typeOnly(() => {
      // @ts-expect-error the collection is a read-only view
      ledger.all.push({ toolCallId: "c2", name: "bash", input: {}, status: "pending" })
      // @ts-expect-error length is read-only
      ledger.all.length = 0
      // @ts-expect-error indexes are read-only
      ledger.all[0] = ledger.all[0]
      // @ts-expect-error collection is a getter-only view
      ledger.all = []
      // @ts-expect-error entry status is read-only
      ledger.get("c1")!.status = "succeeded"
      // @ts-expect-error entry timestamps are read-only
      ledger.get("c1")!.startedAt = 1
      // @ts-expect-error entry note is read-only
      ledger.get("c1")!.note = "x"
      // @ts-expect-error nested input is read-only
      ledger.get("c1")!.input["command"] = "y"
    })

    // The failures above must not have run: state is exactly as created.
    expect(ledger.all).toHaveLength(1)
    expect(ledger.get("c1")?.status).toBe("pending")
    expect(ledger.get("c1")?.input).toEqual({ command: "x" })
  })

  test("legitimate transition methods and serialization still work", () => {
    const ledger = new ToolLedger()
    ledger.pending({ toolCallId: "c1", name: "bash", input: { command: "x" } })
    ledger.running("c1", { startedAt: 1_000 })
    ledger.finished("c1", "succeeded", { finishedAt: 1_450 })

    expect(toolDurationMs(ledger.get("c1")!)).toBe(450)

    const reloaded = ToolLedger.fromJSON(ledger.toJSON())
    expect(reloaded.get("c1")?.status).toBe("succeeded")
    expect(reloaded.get("c1")?.startedAt).toBe(1_000)
    expect(reloaded.get("c1")?.finishedAt).toBe(1_450)
  })

  test("fromJSON copies nested input rather than sharing it", () => {
    const ledger = ToolLedger.fromJSON([
      { toolCallId: "c1", name: "bash", input: { command: "x" }, status: "pending" },
    ])
    // Mutating the source object after loading must not reach the ledger.
    const reloaded = ToolLedger.fromJSON(ledger.toJSON())
    expect(reloaded.get("c1")?.input).toEqual({ command: "x" })
    expect(reloaded.get("c1")?.input).not.toBe(ledger.get("c1")?.input)
  })

  test("replaceAll does not alias the source ledger's internal collection", () => {
    const session = sess()
    const alias = new ToolLedger()
    session.ledger.replaceAll(alias)

    // The caller still holds `alias`; mutating it must not reach the session.
    alias.pending({ toolCallId: "evil", name: "bash", input: {} })
    expect(session.ledger.get("evil")).toBeUndefined()
    expect(session.ledger.all).toHaveLength(0)
  })
})
