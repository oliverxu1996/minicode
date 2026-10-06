/**
 * Manual `/compact` transient lifecycle.
 *
 * The application owns the "compacting" state because a manual compaction has no
 * runtime event. The invariant is that the state's bracket clears on every
 * settle path; these tests exercise the bracket directly, with a fake compactor.
 */
import { describe, expect, test } from "bun:test"
import type { CompactionOutcome, Session } from "@minicode/agent"
import { runCompaction, type CompactionObserver } from "./compaction"

const SESSION = {} as Session
const OK: CompactionOutcome = { status: "compacted", removed: 3 }
const FAILED: CompactionOutcome = { status: "failed", error: "provider exploded" }
const NO_PROGRESS: CompactionOutcome = { status: "no-progress", reason: "empty-tail" }

function runner(result: () => Promise<CompactionOutcome>) {
  return { compact: (_session: Session): Promise<CompactionOutcome> => result() }
}

describe("manual compaction transient lifecycle", () => {
  test("begin precedes the operation and end follows it, on success", async () => {
    const order: string[] = []
    const outcome = await runCompaction(SESSION, runner(async () => { order.push("compact"); return OK }), {
      begin: () => order.push("begin"),
      end: () => order.push("end"),
    })

    expect(order).toEqual(["begin", "compact", "end"])
    expect(outcome).toBe(OK)
  })

  test("the state is entered for the duration of the operation", async () => {
    let compacting = false
    let observedDuring = false
    const observer: CompactionObserver = {
      begin: () => { compacting = true },
      end: () => { compacting = false },
    }

    const outcome = await runCompaction(SESSION, runner(async () => {
      // The model call observes the transient state as set.
      observedDuring = compacting
      return OK
    }), observer)

    expect(observedDuring).toBe(true)
    expect(compacting).toBe(false)
    expect(outcome.status).toBe("compacted")
  })

  test("leaves the state on a reported failure", async () => {
    let ended = 0
    const outcome = await runCompaction(SESSION, runner(async () => FAILED), { begin: () => {}, end: () => ended++ })

    expect(outcome).toBe(FAILED)
    expect(ended).toBe(1)
  })

  test("leaves the state on a no-progress outcome", async () => {
    let ended = 0
    const outcome = await runCompaction(SESSION, runner(async () => NO_PROGRESS), { begin: () => {}, end: () => ended++ })

    expect(outcome).toBe(NO_PROGRESS)
    expect(ended).toBe(1)
  })

  test("leaves the state when the operation throws unexpectedly", async () => {
    let ended = 0
    await expect(
      runCompaction(SESSION, runner(async () => { throw new Error("kaboom") }), { begin: () => {}, end: () => ended++ }),
    ).rejects.toThrow("kaboom")

    expect(ended).toBe(1)
  })

  test("end still runs if entering the state throws", async () => {
    let ended = 0
    await expect(
      runCompaction(SESSION, runner(async () => OK), {
        begin: () => { throw new Error("begin failed") },
        end: () => ended++,
      }),
    ).rejects.toThrow("begin failed")

    expect(ended).toBe(1)
  })

  test("no stale state remains after an unexpected throw", async () => {
    const events: string[] = []
    await expect(
      runCompaction(SESSION, runner(async () => { throw new Error("x") }), {
        begin: () => events.push("begin"),
        end: () => events.push("end"),
      }),
    ).rejects.toThrow()

    // Bracketed exactly once, and the close ran even though the body threw.
    expect(events).toEqual(["begin", "end"])
  })
})
