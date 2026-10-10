import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  activeModelViaManager,
  anthropicStreamEvents,
  sse,
  startMockProvider,
  testConfig,
  withConfigDir,
} from "../../../model/src/test-support"
import { AgentLoop } from "../../src/loop/loop"
import { Session } from "../../src/session/session"
import { CODING_TOOLS, toModelTools } from "../../src/tools"
import { FakeModel, textResponse, toolCallResponse } from "../support/testing"

/** A marker no other part of the prompt could plausibly contain, injected
 *  through `projectInstructions` — the documented AGENTS.md channel. */
const MARKER = "SYSTEM-PROMPT-MARKER-7f3a91"

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "loongcode-sysprompt-"))
}

/** OpenAI chunked SSE for a plain text answer. */
function openaiTextStream(text: string): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  return sse([
    chunk({ role: "assistant", content: text }, null),
    chunk({}, "stop"),
  ])
}

describe("system prompt delivery", () => {
  // ── the wire-level proof the work item asks for ──────────────────────

  test("anthropic: the system prompt reaches the provider as the top-level system field", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        sse(anthropicStreamEvents(["done"], "end_turn", { input: 10, output: 5 })),
      )
      try {
        const model = await activeModelViaManager(testConfig({ protocol: "anthropic", endpoint: provider.url }))
        const dir = runDir()
        try {
          await new AgentLoop(Session.create({ cwd: dir }), model, new Map(CODING_TOOLS))
            .run("hello", { projectInstructions: MARKER })
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }

        const body = provider.requests[0]!.body as Record<string, unknown>
        expect(body.system).toBeDefined()
        // The provider receives the whole prompt, marker included.
        expect(JSON.stringify(body.system)).toContain(MARKER)
        expect(JSON.stringify(body.system)).toContain("You are LoongCode, an opinionated coding agent")
        // Hoisted out of `messages`, so the conversation starts at the user.
        const messages = body.messages as { role: string }[]
        expect(messages[0]!.role).toBe("user")
        expect(messages.some(m => m.role === "system")).toBe(false)
      } finally {
        await provider.close()
      }
    })
  })

  test("openai: the system prompt reaches the provider as the leading message", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() => openaiTextStream("done"))
      try {
        const model = await activeModelViaManager(testConfig({ protocol: "openai", endpoint: provider.url }))
        const dir = runDir()
        try {
          await new AgentLoop(Session.create({ cwd: dir }), model, new Map(CODING_TOOLS))
            .run("hello", { projectInstructions: MARKER })
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }

        const body = provider.requests[0]!.body as Record<string, unknown>
        const messages = body.messages as { role: string; content: unknown }[]
        expect(messages[0]!.role).toBe("system")
        expect(JSON.stringify(messages[0]!.content)).toContain(MARKER)
        expect(JSON.stringify(messages[0]!.content)).toContain("You are LoongCode, an opinionated coding agent")
      } finally {
        await provider.close()
      }
    })
  })

  test("projectInstructions reach the model verbatim", async () => {
    await withConfigDir(async () => {
      const provider = await startMockProvider(() =>
        sse(anthropicStreamEvents(["ok"], "end_turn", { input: 1, output: 1 })),
      )
      try {
        const model = await activeModelViaManager(testConfig({ protocol: "anthropic", endpoint: provider.url }))
        const dir = runDir()
        try {
          await new AgentLoop(Session.create({ cwd: dir }), model, new Map(CODING_TOOLS))
            .run("hello", { projectInstructions: `# AGENTS.md\n${MARKER}\nrun the linter.` })
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
        const body = provider.requests[0]!.body as Record<string, unknown>
        const system = JSON.stringify(body.system)
        expect(system).toContain(MARKER)
        expect(system).toContain("run the linter.")
      } finally {
        await provider.close()
      }
    })
  })

  // ── no duplication, ordering preserved ───────────────────────────────

  test("exactly one system message, prepended, across a multi-turn run", async () => {
    const dir = runDir()
    try {
      const model = new FakeModel([
        toolCallResponse([{ toolCallId: "c1", toolName: "ls", input: { path: "." } }]),
        toolCallResponse([{ toolCallId: "c2", toolName: "ls", input: { path: "." } }]),
        textResponse("finished"),
      ])
      await new AgentLoop(Session.create({ cwd: dir }), model, new Map(CODING_TOOLS))
        .run("do the thing", { projectInstructions: MARKER })

      expect(model.requests.length).toBeGreaterThanOrEqual(3)
      for (const [i, request] of model.requests.entries()) {
        const roles = request.messages.map(m => m.role)
        // Precisely one system message, always first.
        expect(roles.filter(r => r === "system").length).toBe(1)
        expect(roles[0]).toBe("system")
        // It never accumulates as the conversation grows.
        expect(JSON.stringify(request.messages).split(MARKER).length - 1).toBe(1)
      }

      // Ordering of everything else is untouched: system, then the original
      // conversation order.
      const second = model.requests[1]!.messages.map(m => m.role)
      expect(second).toEqual(["system", "user", "assistant", "tool"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the system prompt is not persisted on the session", async () => {
    const dir = runDir()
    try {
      const session = Session.create({ cwd: dir })
      const model = new FakeModel([textResponse("done")])
      await new AgentLoop(session, model, new Map(CODING_TOOLS))
        .run("hello", { projectInstructions: MARKER })

      // Durable history holds the conversation only — so a resumed session
      // cannot replay a stale system prompt. (The session's own message type
      // excludes the "system" role, so this is asserted over the runtime
      // values rather than the narrowed union.)
      const roles: string[] = session.messages.map(m => m.role)
      expect(roles).not.toContain("system")
      expect(JSON.stringify(session.messages)).not.toContain(MARKER)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── nothing else changed ─────────────────────────────────────────────

  test("tool schemas are unaffected by the fix", async () => {
    const dir = runDir()
    try {
      const model = new FakeModel([textResponse("done")])
      await new AgentLoop(Session.create({ cwd: dir }), model, new Map(CODING_TOOLS)).run("hello", {})

      // The request carries exactly the projection of the tool map — the
      // system message changes nothing about it.
      expect(model.requests[0]!.tools).toEqual(toModelTools(CODING_TOOLS))
      expect(model.requests[0]!.tools!.map(t => t.name))
        .toEqual(["read", "write", "edit", "grep", "find", "ls", "bash"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the system prompt carries no credentials or configuration secrets", async () => {
    const dir = runDir()
    try {
      const session = Session.create({ cwd: dir })
      const model = new FakeModel([textResponse("done")])
      await new AgentLoop(session, model, new Map(CODING_TOOLS)).run("hello", {})
      const system = JSON.stringify(model.requests[0]!.messages[0]!.content)
      // Nothing key-shaped.
      expect(system).not.toMatch(/sk-[A-Za-z0-9]|api[_-]?key|bearer\s|token=/i)
      // And it is the prompt content, nothing appended.
      expect(system).toContain("You are LoongCode, an opinionated coding agent")
      expect(system).toContain("<env>")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
