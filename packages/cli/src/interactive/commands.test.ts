import { describe, expect, test } from "bun:test"
import { MiniCode } from "@minicode/agent"
import type { ModelConfig } from "@minicode/model"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMMANDS, findCommand, type CommandContext, type CompactResult } from "./commands"
import { MiniCodeAutocomplete } from "./input/autocomplete"

describe("commands (AC12)", () => {
  test("core commands exist with descriptions", () => {
    const names = COMMANDS.map(c => c.name)
    for (const name of ["help", "model", "new", "session", "compact", "copy", "quit"]) {
      expect(names).toContain(name)
    }
    expect(findCommand("model")?.description.length).toBeGreaterThan(0)
    expect(findCommand("nonexistent")).toBeUndefined()
  })

  test("the retired import/export/hotkeys commands no longer exist", () => {
    // Portability (import/export) and the redundant hotkey listing are gone
    // from the TUI surface; none may remain discoverable or dispatchable.
    for (const name of ["import", "export", "hotkeys"]) {
      expect(findCommand(name)).toBeUndefined()
    }
  })

  test("the retired /trust command no longer exists", () => {
    // Project-local prompts and skills now load unconditionally, so the
    // project-trust concept has no command surface.
    expect(findCommand("trust")).toBeUndefined()
  })

  test("the retired /reload command no longer exists", () => {
    // Prompt templates are discovered live, so no manual refresh remains.
    expect(findCommand("reload")).toBeUndefined()
  })

  test("the retired login/logout commands no longer exist", () => {
    expect(findCommand("login")).toBeUndefined()
    expect(findCommand("logout")).toBeUndefined()
  })

  test("session management is consolidated into /session", () => {
    // `/session` is the single interactive session-management entry point, so
    // the separate session commands must not remain discoverable.
    for (const name of ["resume", "name", "tree", "fork", "clone"]) {
      expect(findCommand(name)).toBeUndefined()
    }
    expect(findCommand("session")?.description).toBe("Manage sessions in this workspace")
  })

  test("/help lists only /new and /session among the session commands", () => {
    const notices: string[] = []
    const ctx = { notify: (text: string) => { notices.push(text) } } as unknown as CommandContext
    findCommand("help")!.execute(ctx, "")
    const help = notices.join("\n")
    expect(help).toContain("/new — Start a fresh session in the same workspace")
    expect(help).toContain("/session — Manage sessions in this workspace")
    for (const removed of ["/resume", "/name", "/tree", "/fork", "/clone"]) {
      expect(help).not.toContain(removed)
    }
  })

  test("autocomplete proposes the consolidated surface and nothing removed", async () => {
    const provider = new MiniCodeAutocomplete(
      () => COMMANDS.map(command => ({ name: command.name, description: command.description })),
      () => process.cwd(),
    )
    const suggestions = await provider.getSuggestions(["/"], 0, 1)
    expect(suggestions).not.toBeNull()
    const labels = suggestions!.items.map(item => item.label)
    expect(labels).toContain("/new")
    expect(labels).toContain("/session")
    for (const removed of ["/resume", "/name", "/tree", "/fork", "/clone"]) {
      expect(labels).not.toContain(removed)
    }
  })

  test("/help and autocomplete no longer advertise removed commands", async () => {
    const removed = ["/import", "/export", "/hotkeys", "/trust", "/reload"]

    const notices: string[] = []
    const ctx = { notify: (text: string) => { notices.push(text) } } as unknown as CommandContext
    findCommand("help")!.execute(ctx, "")
    const help = notices.join("\n")
    for (const name of removed) {
      expect(help).not.toContain(name)
    }

    const provider = new MiniCodeAutocomplete(
      () => COMMANDS.map(command => ({ name: command.name, description: command.description })),
      () => process.cwd(),
    )
    const suggestions = await provider.getSuggestions(["/"], 0, 1)
    expect(suggestions).not.toBeNull()
    const labels = suggestions!.items.map(item => item.label)
    for (const name of removed) {
      expect(labels).not.toContain(name)
    }
  })

  test("/model is a single command with no argument syntax", () => {
    const model = findCommand("model")
    expect(model).toBeDefined()
    expect(model!.description).toBe("Select or add a model")
    expect(model!.argumentHint).toBeUndefined()
    expect(model!.argumentPlaceholder).toBeUndefined()
  })

  test("/model has no textual subcommands (add/edit/remove/configure/model-id)", async () => {
    // Every former argument form must be rejected up front: no picker opens, no
    // model is activated, and nothing is configured.
    for (const arg of ["add", "edit m1", "remove m1", "m1", "configure", "edit", "remove"]) {
      const notices: Array<{ text: string; isError: boolean }> = []
      let picks = 0
      const ctx = {
        agent: () => ({
          modelManager: async () => ({ list: () => [{ id: "m1" }] }),
          currentModel: async () => ({ id: "m1" }),
          activateModel: async () => { throw new Error("must not activate") },
          configureModel: async () => { throw new Error("must not configure") },
        }),
        pick: async () => { picks += 1; return null },
        notify: (text: string, isError?: boolean) => { notices.push({ text, isError: isError === true }) },
      } as unknown as CommandContext

      await findCommand("model")!.execute(ctx, arg)

      expect(notices.at(-1)).toEqual({ text: "usage: /model", isError: true })
      expect(picks).toBe(0)
    }
  })

  test("/help advertises /model without argument syntax", () => {
    const notices: string[] = []
    const ctx = { notify: (text: string) => { notices.push(text) } } as unknown as CommandContext
    findCommand("help")!.execute(ctx, "")
    const help = notices.join("\n")
    expect(help).toContain("/model — Select or add a model")
    for (const stale of ["/model add", "/model edit", "/model remove", "Configure models", "[add |"]) {
      expect(help).not.toContain(stale)
    }
  })

  test("autocomplete proposes /model and never advertises subcommands", async () => {
    const provider = new MiniCodeAutocomplete(
      () => COMMANDS.map(command => ({ name: command.name, description: command.description })),
      () => process.cwd(),
    )
    const all = await provider.getSuggestions(["/"], 0, 1)
    expect(all!.items.map(item => item.label)).toContain("/model")

    // Typing the command name yields only the command itself, never an
    // `add`/`edit`/`remove` form.
    const partial = await provider.getSuggestions(["/model"], 0, 6)
    expect(partial!.items.map(item => item.label)).toEqual(["/model"])
  })
})

/** A command context whose `compact()` returns a scripted result. */
function compactContext(result: CompactResult): { ctx: CommandContext; notices: string[] } {
  const notices: string[] = []
  const ctx = {
    compact: async () => result,
    notify: (text: string) => { notices.push(text) },
  } as unknown as CommandContext
  return { ctx, notices }
}

describe("/compact busy handling", () => {
  test("a compaction already in progress is reported, not started again", async () => {
    const { ctx, notices } = compactContext({ status: "busy", reason: "compacting" })
    await findCommand("compact")!.execute(ctx, "")
    expect(notices).toEqual(["a compaction is already in progress"])
  })

  test("compacting during a run is refused with a distinct message", async () => {
    const { ctx, notices } = compactContext({ status: "busy", reason: "running" })
    await findCommand("compact")!.execute(ctx, "")
    expect(notices).toEqual(["a task is running — wait for it to finish before compacting"])
  })
})

describe("/quit lifecycle", () => {
  test("uses the UI shutdown hook instead of exiting the process directly", async () => {
    // The fullscreen renderer must be stopped through the UI lifecycle so the
    // alternate screen and mouse state are restored before the process exits.
    let quitCalls = 0
    const ctx = {
      quit: () => {
        quitCalls += 1
      },
    } as unknown as CommandContext
    await findCommand("quit")!.execute(ctx, "")
    expect(quitCalls).toBe(1)
  })
})

describe("commands route through their context hooks", () => {
  test("/model still routes through ctx.pick with its title", async () => {
    const pickedTitles: string[] = []
    const ctx = {
      agent: () => ({
        modelManager: async () => ({ list: () => [{ id: "m1" }, { id: "m2" }] }),
        currentModel: async () => ({ id: "m1" }),
      }),
      session: () => ({ id: "current", cwd: "/tmp", messages: [], status: "idle" }),
      pick: async (title: string) => {
        pickedTitles.push(title)
        return null
      },
      notify: () => {},
      setSession: () => {},
    } as unknown as CommandContext

    await findCommand("model")!.execute(ctx, "")

    expect(pickedTitles).toEqual(["Model"])
  })

  test("/session opens the workspace-scoped manager via ctx.manageSessions", async () => {
    let opened = 0
    const ctx = {
      session: () => ({ id: "current", cwd: "/tmp", messages: [], status: "idle" }),
      manageSessions: async () => {
        opened += 1
      },
    } as unknown as CommandContext

    await findCommand("session")!.execute(ctx, "")

    expect(opened).toBe(1)
  })
})

// ── model management (/model) ────────────────────────────────────────

interface ModelRecord {
  id: string
}

interface PickCall {
  title: string
  items: Array<{ value: string; label: string; description?: string }>
  selectedValue?: string
}

interface ModelHarness {
  ctx: CommandContext
  notices: Array<{ text: string; isError: boolean }>
  asks: Array<{ label: string; secret: boolean }>
  picks: PickCall[]
  calls: {
    configured: ModelConfig[]
    activated: string[]
  }
  lastPickItems: Array<{ value: string; label: string; description?: string }>
}

/**
 * A command context over a scripted in-memory model store. `pick` and `ask`
 * are driven per test through handlers, so the command logic — not the picker —
 * is what is under test.
 */
function modelHarness(options: {
  models?: ModelRecord[]
  active?: string
  askResults?: Array<string | null>
  pick?: (call: PickCall, index: number) => string | null
  failConfigure?: Error
  failActivate?: Error
}): ModelHarness {
  const notices: ModelHarness["notices"] = []
  const asks: ModelHarness["asks"] = []
  const picks: PickCall[] = []
  const calls: ModelHarness["calls"] = { configured: [], activated: [] }
  const askResults = [...(options.askResults ?? [])]
  const models = options.models ?? []
  const byId = new Map(models.map(m => [m.id, m]))
  const lastPickItems: ModelHarness["lastPickItems"] = []
  let pickCall = 0

  const manager = {
    list: () => models.map(m => ({ id: m.id })),
  }

  const ctx = {
    agent: () => ({
      modelManager: async () => manager,
      currentModel: async () => (options.active === undefined ? undefined : { id: options.active }),
      configureModel: async (config: ModelConfig) => {
        if (options.failConfigure) throw options.failConfigure
        calls.configured.push(config)
      },
      activateModel: async (id: string) => {
        if (options.failActivate) throw options.failActivate
        if (!byId.has(id)) throw new Error(`model "${id}" is not configured`)
        calls.activated.push(id)
      },
    }),
    notify: (text: string, isError?: boolean) => {
      notices.push({ text, isError: isError === true })
    },
    pick: async (
      title: string,
      items: Array<{ value: string; label: string; description?: string }>,
      opts?: { selectedValue?: string },
    ) => {
      const call: PickCall = { title, items, selectedValue: opts?.selectedValue }
      picks.push(call)
      lastPickItems.length = 0
      lastPickItems.push(...items)
      const result = options.pick?.(call, pickCall) ?? null
      pickCall += 1
      return result
    },
    ask: async (label: string, opts?: { secret?: boolean }) => {
      asks.push({ label, secret: opts?.secret === true })
      return askResults.length > 0 ? askResults.shift()! : null
    },
  } as unknown as CommandContext

  return { ctx, notices, asks, picks, calls, lastPickItems }
}

/** Value of the first item whose label matches. */
function byLabel(call: PickCall, label: string): string | null {
  return call.items.find(item => item.label === label)?.value ?? null
}

/**
 * A pick handler covering the `/model` picker and the add wizard's protocol and
 * commit steps. `protocol` selects the protocol item; `limits` chooses
 * `Configure limits…` at the commit step instead of the primary action.
 */
function wizard(
  opts: { protocol?: "openai" | "anthropic"; limits?: boolean } = {},
): (call: PickCall) => string | null {
  return call => {
    if (call.title === "Model") return byLabel(call, "Add model…")
    if (call.title === "Protocol") {
      return byLabel(call, opts.protocol === "anthropic" ? "Anthropic" : "OpenAI-compatible")
    }
    if (call.title.startsWith("Add ")) {
      if (opts.limits) return byLabel(call, "Configure limits…")
      return byLabel(call, "Add model")
    }
    return null
  }
}

describe("/model selection", () => {
  test("lists configured models, marks the active one, and offers only Add model…", async () => {
    const h = modelHarness({ models: [{ id: "m1" }, { id: "m2" }], active: "m1" })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.lastPickItems.map(i => i.label)).toEqual(["m1", "m2", "Add model…"])
    expect(h.lastPickItems[0]!.description).toBe("active")
    expect(h.lastPickItems[1]!.description).toBeUndefined()
    expect(h.lastPickItems.some(i => i.label === "Configure models…")).toBe(false)
  })

  test("selecting a configured model activates it", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }, { id: "m2" }],
      active: "m1",
      pick: call => (call.title === "Model" ? "m2" : null),
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.activated).toEqual(["m2"])
    expect(h.notices.at(-1)).toEqual({ text: "active model: m2", isError: false })
  })

  test("Esc cancels without changing the active model", async () => {
    const h = modelHarness({ models: [{ id: "m1" }, { id: "m2" }], active: "m1" })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.activated).toEqual([])
    expect(h.calls.configured).toEqual([])
    expect(h.notices).toEqual([])
  })

  test("an activation failure is a normal error notice", async () => {
    const h = modelHarness({ models: [{ id: "m1" }], active: "m1", pick: () => "ghost" })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.notices.at(-1)!.isError).toBe(true)
    expect(h.notices.at(-1)!.text).toContain("cannot activate model")
  })
})

describe("/model add", () => {
  test("zero configured models: the picker collapses to Add model…", async () => {
    const h = modelHarness({ models: [] })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.lastPickItems.map(i => i.label)).toEqual(["Add model…"])
  })

  test("with no models, choosing Add model… runs the wizard and configures", async () => {
    const h = modelHarness({ models: [], askResults: ["", "gpt-5", "sk"], pick: wizard() })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured).toHaveLength(1)
    expect(h.calls.configured[0]).toMatchObject({
      id: "gpt-5",
      name: "gpt-5",
      protocol: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5",
      apiKey: "sk",
      contextWindow: 128000,
      maxOutputTokens: 8192,
    })
    expect(h.notices.at(-1)).toEqual({ text: 'model "gpt-5" configured and activated', isError: false })
  })

  test("asks only for protocol, endpoint, model, and API key; defaults the limits", async () => {
    const h = modelHarness({ models: [], askResults: ["", "gpt-5", "sk-new"], pick: wizard() })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.asks.map(a => a.label).some(l => l.includes("context window"))).toBe(false)
    expect(h.calls.configured[0]).toMatchObject({
      protocol: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5",
      apiKey: "sk-new",
      contextWindow: 128000,
      maxOutputTokens: 8192,
    })
  })

  test("endpoint accepts the protocol default when left blank", async () => {
    const h = modelHarness({ askResults: ["", "gpt-5", "sk"], pick: wizard({ protocol: "anthropic" }) })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured[0]!.endpoint).toBe("https://api.anthropic.com/v1")
    expect(h.calls.configured[0]!.protocol).toBe("anthropic")
  })

  test("a custom endpoint is used verbatim", async () => {
    const h = modelHarness({ askResults: ["https://my.gateway.example/v1", "gpt-5", "sk"], pick: wizard() })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured[0]!.endpoint).toBe("https://my.gateway.example/v1")
  })

  test("the API key prompt is masked", async () => {
    const h = modelHarness({ askResults: ["", "gpt-5", "sk-secret"], pick: wizard() })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.asks.find(a => a.label === "api key:")?.secret).toBe(true)
  })

  test("Configure limits… overrides both limits and they are persisted", async () => {
    const h = modelHarness({
      askResults: ["", "gpt-5", "sk", "200000", "16000"],
      pick: wizard({ limits: true }),
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured[0]).toMatchObject({ contextWindow: 200000, maxOutputTokens: 16000 })
  })

  test("accepting the limits defaults keeps the generated limits", async () => {
    const h = modelHarness({ askResults: ["", "gpt-5", "sk", "", ""], pick: wizard({ limits: true }) })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured[0]).toMatchObject({ contextWindow: 128000, maxOutputTokens: 8192 })
  })

  test("a required model identifier is enforced", async () => {
    const h = modelHarness({ askResults: ["", ""], pick: wizard() })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured).toEqual([])
    expect(h.notices.at(-1)).toEqual({ text: "model identifier is required", isError: true })
  })

  test("a colliding generated id asks for a different local id instead of overwriting", async () => {
    const h = modelHarness({
      models: [{ id: "gpt-5" }],
      askResults: ["", "gpt-5", "sk", "gpt-5-eu"],
      pick: wizard(),
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured).toHaveLength(1)
    expect(h.calls.configured[0]!.id).toBe("gpt-5-eu")
    expect(h.asks.some(a => a.label.includes('"gpt-5" already exists'))).toBe(true)
  })

  test("a still-colliding replacement is rejected and re-asked", async () => {
    const h = modelHarness({
      models: [{ id: "gpt-5" }, { id: "gpt-5-eu" }],
      askResults: ["", "gpt-5", "sk", "gpt-5-eu", "gpt-5-eu-2"],
      pick: wizard(),
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured[0]!.id).toBe("gpt-5-eu-2")
  })

  test("cancelling the collision prompt leaves nothing added", async () => {
    const h = modelHarness({
      models: [{ id: "gpt-5" }],
      askResults: ["", "gpt-5", "sk", null],
      pick: wizard(),
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured).toEqual([])
    expect(h.notices.at(-1)!.text).toBe("cancelled")
  })

  test("a configureModel failure is a normal error notice", async () => {
    const h = modelHarness({
      askResults: ["", "gpt-5", "sk"],
      pick: wizard(),
      failConfigure: new Error('model id "gpt-5" is already configured'),
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.notices.at(-1)!.isError).toBe(true)
    expect(h.notices.at(-1)!.text).toContain("already configured")
  })
})

describe("wizard cancellation", () => {
  for (const [name, cancelAt, asks] of [
    ["protocol", "protocol", []],
    ["endpoint", "endpoint", [null]],
    ["model", "model", ["", null]],
    ["api key", "api key", ["", "gpt-5", null]],
    ["commit", "commit", ["", "gpt-5", "sk"]],
  ] as const) {
    test(`Escape at the ${name} step cancels without persisting`, async () => {
      const h = modelHarness({
        askResults: [...asks],
        pick: call => {
          if (call.title === "Model") return byLabel(call, "Add model…")
          if (call.title === "Protocol") {
            return cancelAt === "protocol" ? null : byLabel(call, "OpenAI-compatible")
          }
          if (call.title.startsWith("Add ")) {
            return cancelAt === "commit" ? null : byLabel(call, "Add model")
          }
          return null
        },
      })
      await findCommand("model")!.execute(h.ctx, "")
      expect(h.calls.configured).toEqual([])
      expect(h.notices.at(-1)).toEqual({ text: "cancelled", isError: false })
    })
  }
})

// ── real persistence through the runtime bridge ──────────────────────

/**
 * Runs a scripted `/model` against a real MiniCode agent (real ModelManager,
 * a real `models.json` under a temp `MINICODE_CONFIG_DIR`), so selection and
 * addition are proven to persist through the actual runtime bridge rather than
 * a fake.
 */
async function withRealModelConfig(
  seed: (dir: string) => void,
  io: { pick?: (call: PickCall, index: number) => string | null; asks?: Array<string | null> },
  run: (ctx: CommandContext, notices: Array<{ text: string; isError: boolean }>, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "minicode-cli-model-"))
  const previous = process.env.MINICODE_CONFIG_DIR
  process.env.MINICODE_CONFIG_DIR = dir
  try {
    seed(dir)
    const notices: Array<{ text: string; isError: boolean }> = []
    const asks = [...(io.asks ?? [])]
    let pickCall = 0
    const agent = new MiniCode()
    const ctx = {
      agent: () => agent,
      notify: (text: string, isError?: boolean) => { notices.push({ text, isError: isError === true }) },
      pick: async (title: string, items: Array<{ value: string; label: string; description?: string }>) => {
        const call: PickCall = { title, items }
        const result = io.pick?.(call, pickCall) ?? null
        pickCall += 1
        return result
      },
      ask: async () => (asks.length > 0 ? asks.shift()! : null),
    } as unknown as CommandContext
    await run(ctx, notices, dir)
  } finally {
    if (previous === undefined) delete process.env.MINICODE_CONFIG_DIR
    else process.env.MINICODE_CONFIG_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

function persistedModels(dir: string): {
  models: Array<{ id: string; name: string; model: string; apiKey: string }>
  activeModelId: string | null
} {
  return JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"))
}

describe("/model persists through the real runtime bridge", () => {
  test("selecting a model persists the active model", async () => {
    await withRealModelConfig(
      dir => writeFileSync(join(dir, "models.json"), JSON.stringify({
        version: 1,
        models: [
          { id: "m1", name: "m1", protocol: "openai", endpoint: "https://api.example.com/v1", model: "m1", apiKey: "k1", contextWindow: 128000, maxOutputTokens: 8192 },
          { id: "m2", name: "m2", protocol: "openai", endpoint: "https://api.example.com/v1", model: "m2", apiKey: "k2", contextWindow: 128000, maxOutputTokens: 8192 },
        ],
        activeModelId: "m1",
      })),
      { pick: call => (call.title === "Model" ? "m2" : null) },
      async (ctx, notices, dir) => {
        await findCommand("model")!.execute(ctx, "")
        expect(notices.at(-1)).toEqual({ text: "active model: m2", isError: false })
        expect(persistedModels(dir).activeModelId).toBe("m2")
      },
    )
  })

  test("adding a model persists it and makes it active", async () => {
    await withRealModelConfig(
      () => {},
      {
        pick: call => {
          if (call.title === "Model") return byLabel(call, "Add model…")
          if (call.title === "Protocol") return byLabel(call, "OpenAI-compatible")
          if (call.title.startsWith("Add ")) return byLabel(call, "Add model")
          return null
        },
        asks: ["", "gpt-5", "sk-new"],
      },
      async (ctx, notices, dir) => {
        await findCommand("model")!.execute(ctx, "")
        expect(notices.at(-1)).toEqual({ text: 'model "gpt-5" configured and activated', isError: false })
        const persisted = persistedModels(dir)
        expect(persisted.models.map(m => m.id)).toEqual(["gpt-5"])
        expect(persisted.activeModelId).toBe("gpt-5")
        expect(persisted.models[0]!.apiKey).toBe("sk-new")
      },
    )
  })

  test("adding a second model keeps both and activates the new one", async () => {
    await withRealModelConfig(
      dir => writeFileSync(join(dir, "models.json"), JSON.stringify({
        version: 1,
        models: [{ id: "existing", name: "existing", protocol: "openai", endpoint: "https://api.example.com/v1", model: "existing", apiKey: "k", contextWindow: 128000, maxOutputTokens: 8192 }],
        activeModelId: "existing",
      })),
      {
        pick: call => {
          if (call.title === "Model") return byLabel(call, "Add model…")
          if (call.title === "Protocol") return byLabel(call, "Anthropic")
          if (call.title.startsWith("Add ")) return byLabel(call, "Add model")
          return null
        },
        asks: ["", "claude-sonnet-4-5", "sk-ant"],
      },
      async (ctx, _notices, dir) => {
        await findCommand("model")!.execute(ctx, "")
        const persisted = persistedModels(dir)
        expect(persisted.models.map(m => m.id)).toEqual(["existing", "claude-sonnet-4-5"])
        expect(persisted.activeModelId).toBe("claude-sonnet-4-5")
      },
    )
  })
})
