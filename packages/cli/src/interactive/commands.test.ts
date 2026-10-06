import { describe, expect, test } from "bun:test"
import type { ModelConfig } from "@minicode/model"
import { COMMANDS, findCommand, type CommandContext, type CompactResult } from "./commands"

describe("commands (AC12)", () => {
  test("core commands exist with descriptions", () => {
    const names = COMMANDS.map(c => c.name)
    for (const name of ["help", "model", "login", "logout", "new", "resume", "name", "session", "compact", "copy", "export", "import", "trust", "reload", "fork", "clone", "tree", "hotkeys", "quit"]) {
      expect(names).toContain(name)
    }
    expect(findCommand("model")?.description.length).toBeGreaterThan(0)
    expect(findCommand("nonexistent")).toBeUndefined()
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

describe("/hotkeys documentation", () => {
  test("advertises the current submit/newline keys and no follow-up queue", async () => {
    const notices: string[] = []
    const ctx = { notify: (text: string) => { notices.push(text) } } as unknown as CommandContext

    await findCommand("hotkeys")!.execute(ctx, "")

    expect(notices).toHaveLength(1)
    const text = notices[0]!

    // The retired Alt+Enter follow-up queue must not be advertised anymore.
    expect(text).not.toMatch(/queue/i)
    expect(text).not.toMatch(/follow[\s-]?up/i)

    // Enter submits; Alt+Enter / Shift+Enter / Ctrl+J insert a newline.
    const submitLine = text.split("\n")[0]!
    expect(submitLine).toContain("enter — submit")
    expect(submitLine).toContain("alt+enter")
    expect(submitLine).toContain("shift+enter")
    expect(submitLine).toContain("ctrl+j")
    expect(submitLine).toContain("newline")
  })
})

describe("selector commands share the picker path", () => {
  test("every picker caller routes through ctx.pick with its title", async () => {
    // All five commands route through ctx.pick, and the application renders the
    // returned selector in the shared bottom-attached picker slot, so the
    // presentation applies uniformly rather than per command.
    const pickedTitles: string[] = []
    const now = Date.now()
    const summary = {
      id: "s1",
      title: "existing",
      firstUser: "hi",
      messageCount: 2,
      updatedAt: now,
      parentSessionId: "current",
    }
    const userMessage = { id: "u1", role: "user", content: "hello", status: "complete", timestamp: 1 }
    const ctx = {
      agent: () => ({
        modelManager: async () => ({ list: () => [{ id: "m1" }, { id: "m2" }] }),
        currentModel: async () => ({ id: "m1" }),
        sessionSummaries: async () => [summary],
        loadSession: async () => ({}),
        createSession: () => ({}),
      }),
      session: () => ({ id: "current", cwd: "/tmp", messages: [userMessage], status: "idle" }),
      pick: async (title: string) => {
        pickedTitles.push(title)
        return null
      },
      notify: () => {},
      setSession: () => {},
    } as unknown as CommandContext

    await findCommand("model")!.execute(ctx, "")
    await findCommand("logout")!.execute(ctx, "")
    await findCommand("resume")!.execute(ctx, "")
    await findCommand("fork")!.execute(ctx, "")
    await findCommand("tree")!.execute(ctx, "")

    expect(pickedTitles).toEqual([
      "Model",
      "Remove model",
      "Resume session",
      "Fork from message",
      "Forked sessions",
    ])
  })
})

// ── model management (/model) ────────────────────────────────────────

interface ModelRecord {
  id: string
}

function baseConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "m1",
    name: "m1",
    protocol: "openai",
    endpoint: "https://api.example.com/v1",
    model: "gpt-4.1",
    apiKey: "sk-existing",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    ...overrides,
  }
}

interface ModelHarness {
  ctx: CommandContext
  notices: Array<{ text: string; isError: boolean }>
  asks: Array<{ label: string; secret: boolean }>
  calls: {
    configured: ModelConfig[]
    updated: ModelConfig[]
    activated: string[]
    removed: string[]
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
  configs?: Record<string, ModelConfig>
  askResults?: Array<string | null>
  pick?: (title: string, items: Array<{ value: string; label: string; description?: string }>, call: number) => string | null
  failConfigure?: Error
  failUpdate?: Error
  failRemove?: Error
  failActivate?: Error
}): ModelHarness {
  const notices: ModelHarness["notices"] = []
  const asks: ModelHarness["asks"] = []
  const calls: ModelHarness["calls"] = { configured: [], updated: [], activated: [], removed: [] }
  const askResults = [...(options.askResults ?? [])]
  const models = options.models ?? []
  const byId = new Map(models.map(m => [m.id, m]))
  const configs = options.configs ?? {}
  const lastPickItems: ModelHarness["lastPickItems"] = []
  let pickCall = 0

  const manager = {
    list: () => models.map(m => ({ id: m.id })),
    config: (id: string) => configs[id],
    update: (config: ModelConfig) => {
      if (options.failUpdate) throw options.failUpdate
      calls.updated.push(config)
    },
    activate: (id: string) => {
      if (!byId.has(id)) throw new Error(`model "${id}" is not configured`)
      calls.activated.push(id)
    },
    remove: (id: string) => {
      if (options.failRemove) throw options.failRemove
      calls.removed.push(id)
    },
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
    pick: async (title: string, items: Array<{ value: string; label: string; description?: string }>) => {
      lastPickItems.length = 0
      lastPickItems.push(...items)
      const result = options.pick?.(title, items, pickCall) ?? null
      pickCall += 1
      return result
    },
    ask: async (label: string, opts?: { secret?: boolean }) => {
      asks.push({ label, secret: opts?.secret === true })
      return askResults.length > 0 ? askResults.shift()! : null
    },
  } as unknown as CommandContext

  return { ctx, notices, asks, calls, lastPickItems }
}

describe("/model management surface", () => {
  test("no models: the picker offers Add model… and opens the add flow", async () => {
    const h = modelHarness({
      models: [],
      askResults: ["openai", "", "fresh", "gpt-4.1", "sk-new", "", ""],
      pick: (title, items) => {
        expect(title).toBe("Model")
        return items[0]!.value
      },
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured).toHaveLength(1)
    expect(h.calls.configured[0]!.id).toBe("fresh")
    expect(h.notices.at(-1)).toEqual({ text: 'model "fresh" configured and activated', isError: false })
  })

  test("models exist: the picker lists them and a Configure models… action", async () => {
    const h = modelHarness({ models: [{ id: "m1" }, { id: "m2" }], active: "m1" })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.lastPickItems.map(i => i.label)).toEqual(["m1", "m2", "Configure models…"])
    // The active model is marked.
    expect(h.lastPickItems[0]!.description).toBe("active")
    expect(h.lastPickItems[1]!.description).toBeUndefined()
  })

  test("selecting a model activates it", async () => {
    const h = modelHarness({ models: [{ id: "m1" }, { id: "m2" }], active: "m1", pick: () => "m2" })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.activated).toEqual(["m2"])
    expect(h.notices.at(-1)!.text).toBe("active model: m2")
  })

  test("Configure models… → Add model… runs the add flow", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }],
      active: "m1",
      askResults: ["anthropic", "", "m2", "claude-sonnet-4-5", "sk-2", "200000", "16000"],
      pick: (title, items) => {
        if (title === "Model") return items.find(i => i.label === "Configure models…")!.value
        if (title === "Configure models") return items.find(i => i.label === "Add model…")!.value
        return null
      },
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured).toHaveLength(1)
    const config = h.calls.configured[0]!
    expect(config).toMatchObject({
      id: "m2",
      protocol: "anthropic",
      endpoint: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-5",
      apiKey: "sk-2",
      contextWindow: 200000,
      maxOutputTokens: 16000,
    })
    // The API key prompt is secret.
    expect(h.asks.find(a => a.label === "api key:")?.secret).toBe(true)
  })

  test("Configure models… → Edit model… targets the chosen model and preserves the key on blank", async () => {
    const base = baseConfig()
    const h = modelHarness({
      models: [{ id: "m1" }],
      active: "m1",
      configs: { m1: base },
      askResults: ["", "", "", "", "", ""],
      pick: (title, items) => {
        if (title === "Model") return items.find(i => i.label === "Configure models…")!.value
        if (title === "Configure models") return items.find(i => i.label === "Edit model…")!.value
        if (title === "Edit model") return "m1"
        return null
      },
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.updated).toHaveLength(1)
    expect(h.calls.updated[0]).toEqual(base) // unchanged defaults, key kept
    expect(h.notices.at(-1)!.text).toBe('model "m1" updated')
  })

  test("Configure models… → Remove model… confirms, then removes a non-active model", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }, { id: "m2" }],
      active: "m1",
      pick: (title, items) => {
        if (title === "Model") return items.find(i => i.label === "Configure models…")!.value
        if (title === "Configure models") return items.find(i => i.label === "Remove model…")!.value
        if (title === "Remove model" && items.some(i => i.value === "remove")) return "remove"
        if (title === "Remove model") return "m2"
        return null
      },
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.removed).toEqual(["m2"])
    expect(h.calls.activated).toEqual([])
    expect(h.notices.at(-1)!.text).toBe('removed model "m2"')
  })

  test("removing a model requires an explicit confirmation", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }, { id: "m2" }],
      active: "m1",
      pick: (title, items) => {
        if (title === "Remove model" && items.some(i => i.value === "cancel")) return "cancel"
        return null
      },
    })
    await findCommand("model")!.execute(h.ctx, "remove m2")
    expect(h.calls.removed).toEqual([])
    expect(h.notices.at(-1)!.text).toBe("cancelled")
  })

  test("removing the active model with others requires an explicit replacement", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }, { id: "m2" }],
      active: "m1",
      pick: (title, items) => {
        if (title === "Remove model" && items.some(i => i.value === "remove")) return "remove"
        if (title === "Activate model") return "m2"
        return null
      },
    })
    await findCommand("model")!.execute(h.ctx, "remove m1")
    expect(h.calls.removed).toEqual(["m1"])
    expect(h.calls.activated).toEqual(["m2"])
    expect(h.notices.at(-1)!.text).toBe('removed model "m1" — active model: m2')
  })

  test("cancelling the replacement decision abandons the removal", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }, { id: "m2" }],
      active: "m1",
      pick: (title, items) => {
        if (title === "Remove model" && items.some(i => i.value === "remove")) return "remove"
        return null // cancel the replacement choice
      },
    })
    await findCommand("model")!.execute(h.ctx, "remove m1")
    expect(h.calls.removed).toEqual([])
    expect(h.notices.at(-1)!.text).toBe("cancelled")
  })

  test("removing the last model leaves no active model (valid)", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }],
      active: "m1",
      pick: (title, items) => {
        if (title === "Remove model" && items.some(i => i.value === "remove")) return "remove"
        return null
      },
    })
    await findCommand("model")!.execute(h.ctx, "remove m1")
    expect(h.calls.removed).toEqual(["m1"])
    expect(h.calls.activated).toEqual([])
    expect(h.notices.at(-1)!.text).toBe('removed model "m1"')
  })

  test("direct selection by id activates it", async () => {
    const h = modelHarness({ models: [{ id: "m1" }, { id: "m2" }], active: "m1" })
    await findCommand("model")!.execute(h.ctx, "m2")
    expect(h.calls.activated).toEqual(["m2"])
  })
})

describe("/model error paths", () => {
  test("cancelling the add flow reports cancellation, not an invalid protocol", async () => {
    const h = modelHarness({ askResults: [null] })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured).toEqual([])
    expect(h.notices.at(-1)).toEqual({ text: "cancelled", isError: false })
  })

  test("cancelling mid-flow (at the secret key) is reported as cancellation", async () => {
    const h = modelHarness({ askResults: ["openai", "", "newid", "gpt-4.1", null] })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured).toEqual([])
    expect(h.notices.at(-1)).toEqual({ text: "cancelled", isError: false })
  })

  test("an invalid configuration from the store is an error notice", async () => {
    const h = modelHarness({
      askResults: ["openai", "not-a-url", "newid", "gpt-4.1", "sk", "", ""],
      failConfigure: new Error("model configuration.endpoint must be a valid URL"),
    })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.notices.at(-1)!.isError).toBe(true)
    expect(h.notices.at(-1)!.text).toContain("must be a valid URL")
  })

  test("an invalid protocol is a validation error", async () => {
    const h = modelHarness({ askResults: ["gemini"] })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.notices.at(-1)).toEqual({ text: "protocol must be openai or anthropic", isError: true })
  })

  test("a duplicate id becomes an error notice, not a throw", async () => {
    const h = modelHarness({
      askResults: ["openai", "", "m1", "gpt-4.1", "sk", "", ""],
      failConfigure: new Error('model id "m1" is already configured'),
    })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.notices.at(-1)!.isError).toBe(true)
    expect(h.notices.at(-1)!.text).toContain("already configured")
  })

  test("editing an unknown id is an error notice", async () => {
    const h = modelHarness({ models: [{ id: "m1" }], configs: {} })
    await findCommand("model")!.execute(h.ctx, "edit ghost")
    expect(h.notices.at(-1)).toEqual({ text: 'model "ghost" is not configured', isError: true })
  })

  test("removing an unknown id is an error notice", async () => {
    const h = modelHarness({ models: [{ id: "m1" }] })
    await findCommand("model")!.execute(h.ctx, "remove ghost")
    expect(h.notices.at(-1)).toEqual({ text: 'model "ghost" is not configured', isError: true })
  })

  test("a persistence failure on update is an error notice", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }],
      configs: { m1: baseConfig() },
      askResults: ["", "", "", "", "", ""],
      failUpdate: new Error("cannot persist model configuration to /x: EACCES"),
    })
    await findCommand("model")!.execute(h.ctx, "edit m1")
    expect(h.notices.at(-1)!.isError).toBe(true)
    expect(h.notices.at(-1)!.text).toContain("cannot persist")
  })

  test("missing direct-command arguments produce usage errors", async () => {
    for (const args of ["edit", "remove"]) {
      const h = modelHarness({ models: [{ id: "m1" }] })
      await findCommand("model")!.execute(h.ctx, args)
      expect(h.notices.at(-1)!.isError).toBe(true)
      expect(h.notices.at(-1)!.text).toContain(`usage: /model ${args}`)
    }
  })
})

describe("compatibility aliases", () => {
  test("/login maps to the add flow and announces the deprecation", async () => {
    const h = modelHarness({ askResults: ["openai", "", "m1", "gpt-4.1", "sk", "", ""] })
    await findCommand("login")!.execute(h.ctx, "")
    expect(h.notices[0]).toEqual({ text: "login is deprecated — use /model add", isError: false })
    expect(h.calls.configured).toHaveLength(1)
  })

  test("/logout maps to the remove flow and announces the deprecation", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }, { id: "m2" }],
      active: "m1",
      pick: (title, items) => {
        if (title === "Remove model" && !items.some(i => i.value === "remove")) return "m2"
        if (title === "Remove model") return "remove"
        return null
      },
    })
    await findCommand("logout")!.execute(h.ctx, "")
    expect(h.notices[0]).toEqual({ text: "logout is deprecated — use /model remove", isError: false })
    expect(h.calls.removed).toEqual(["m2"])
  })
})
