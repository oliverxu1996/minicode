import { describe, expect, test } from "bun:test"
import { ModelError } from "@minicode/model"
import { Compactor } from "../../src/context/compaction"
import { Session } from "../../src/session/session"
import { FakeModel, textResponse } from "../support/testing"

/** A session with a compactable region: an older turn large enough that the
 *  preserved tail stops before it, and a trailing assistant turn so the last
 *  message is not the last user message. */
function sessionWithHistory(): Session {
  const session = Session.create({ cwd: "/tmp/minicode-compact-test" })
  session.pushUser("x".repeat(12_000))
  session.pushUser("y".repeat(4_000))
  session.appendAssistant([{ type: "text", text: "working" }], {})
  return session
}

describe("compaction reports what its own model call consumed (O4)", () => {
  test("a completed compaction carries the summarization call's usage", async () => {
    const session = sessionWithHistory()
    const model = new FakeModel([
      textResponse("summary", { usage: { inputTokens: 500, outputTokens: 60 } }),
    ])

    const outcome = await new Compactor(model, 1000).compact(session)

    expect(outcome).toEqual({
      status: "compacted",
      removed: 1,
      usage: { inputTokens: 500, outputTokens: 60 },
    })
  })

  test("a compaction that cannot start reports no usage and calls no model", async () => {
    const session = Session.create({ cwd: "/tmp/minicode-compact-test" })
    session.pushUser("the only turn") // the last message is a user message
    const model = new FakeModel([textResponse("summary")])

    const outcome = await new Compactor(model, 1000).compact(session)

    expect(outcome).toEqual({ status: "no-progress", reason: "no-compactable-region" })
    expect(outcome).not.toHaveProperty("usage")
    expect(model.requests).toHaveLength(0)
  })

  test("a summarization that yields nothing reports no usage", async () => {
    const session = sessionWithHistory()
    const model = new FakeModel([textResponse("")])

    const outcome = await new Compactor(model, 1000).compact(session)

    expect(outcome).toEqual({ status: "no-progress", reason: "empty-summary" })
    expect(outcome).not.toHaveProperty("usage")
  })

  test("a failed summarization reports no usage", async () => {
    const session = sessionWithHistory()
    const model = new FakeModel([{ error: new ModelError("request_failed", "boom") }])

    const outcome = await new Compactor(model, 1000).compact(session)

    expect(outcome.status).toBe("failed")
    expect(outcome).not.toHaveProperty("usage")
  })

  // A command-level /compact is not a run: compaction rewrites history, and
  // nothing here may invent a run to attribute it to.
  test("a command-level compaction invents no run attribution", async () => {
    const session = sessionWithHistory()
    const model = new FakeModel([
      textResponse("summary", { usage: { inputTokens: 500, outputTokens: 60 } }),
    ])

    await new Compactor(model, 1000).compact(session)

    expect(session.runs).toEqual([])
  })
})
