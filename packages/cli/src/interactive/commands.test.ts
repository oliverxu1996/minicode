import { describe, expect, test } from "bun:test"
import type { ModelConfig } from "@minicode/model"
import { COMMANDS, findCommand, type CommandContext, type CompactResult } from "./commands"

describe("commands (AC12)", () => {
  test("core commands exist with descriptions", () => {
    const names = COMMANDS.map(c => c.name)
    for (const name of ["help", "model", "new", "resume", "name", "session", "compact", "copy", "export", "import", "trust", "reload", "fork", "clone", "tree", "hotkeys", "quit"]) {
      expect(names).toContain(name)
    }
    expect(findCommand("model")?.description.length).toBeGreaterThan(0)
    expect(findCommand("nonexistent")).toBeUndefined()
  })

  test("the retired login/logout commands no longer exist", () => {
    expect(findCommand("login")).toBeUndefined()
    expect(findCommand("logout")).toBeUndefined()
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
    // Every picker caller routes through ctx.pick, and the application renders
    // the returned selector in the shared bottom-attached picker slot, so the
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
    await findCommand("resume")!.execute(ctx, "")
    await findCommand("fork")!.execute(ctx, "")
    await findCommand("tree")!.execute(ctx, "")

    expect(pickedTitles).toEqual([
      "Model",
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
  pick?: (call: PickCall, index: number) => string | null
  failConfigure?: Error
  failUpdate?: Error
  failRemove?: Error
  failActivate?: Error
}): ModelHarness {
  const notices: ModelHarness["notices"] = []
  const asks: ModelHarness["asks"] = []
  const picks: ModelHarness["picks"] = []
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
 * A pick handler covering the model-management menus and the wizard's protocol
 * and commit steps. `protocol` selects the protocol item; `limits` chooses
 * `Configure limits…` at the commit step instead of the primary action.
 */
function wizard(
  opts: { protocol?: "openai" | "anthropic"; limits?: boolean } = {},
): (call: PickCall) => string | null {
  return call => {
    if (call.title === "Protocol") {
      return byLabel(call, opts.protocol === "anthropic" ? "Anthropic" : "OpenAI-compatible")
    }
    if (call.title.startsWith("Add ") || call.title.startsWith("Edit ")) {
      if (opts.limits) return byLabel(call, "Configure limits…")
      return call.items.some(i => i.label === "Add model") ? byLabel(call, "Add model") : byLabel(call, "Save changes")
    }
    return null
  }
}

describe("/model add wizard", () => {
  test("asks only for protocol, endpoint, model, and API key; defaults the limits", async () => {
    const h = modelHarness({
      models: [],
      askResults: ["", "gpt-5", "sk-new"],
      pick: wizard(),
    })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured).toHaveLength(1)
    expect(h.calls.configured[0]).toMatchObject({
      id: "gpt-5",
      name: "gpt-5",
      protocol: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-5",
      apiKey: "sk-new",
      contextWindow: 128000,
      maxOutputTokens: 8192,
    })
    // No context-window/max-output prompt on the normal path.
    expect(h.asks.map(a => a.label).some(l => l.includes("context window"))).toBe(false)
    expect(h.notices.at(-1)).toEqual({ text: 'model "gpt-5" configured and activated', isError: false })
  })

  test("endpoint accepts the protocol default when left blank", async () => {
    const h = modelHarness({ askResults: ["", "gpt-5", "sk"], pick: wizard({ protocol: "anthropic" }) })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured[0]!.endpoint).toBe("https://api.anthropic.com/v1")
    expect(h.calls.configured[0]!.protocol).toBe("anthropic")
  })

  test("a custom endpoint is used verbatim", async () => {
    const h = modelHarness({ askResults: ["https://my.gateway.example/v1", "gpt-5", "sk"], pick: wizard() })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured[0]!.endpoint).toBe("https://my.gateway.example/v1")
  })

  test("the API key prompt is masked", async () => {
    const h = modelHarness({ askResults: ["", "gpt-5", "sk-secret"], pick: wizard() })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.asks.find(a => a.label === "api key:")?.secret).toBe(true)
  })

  test("Advanced overrides both limits and they are persisted", async () => {
    const h = modelHarness({
      askResults: ["", "gpt-5", "sk", "200000", "16000"],
      pick: wizard({ limits: true }),
    })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured[0]).toMatchObject({ contextWindow: 200000, maxOutputTokens: 16000 })
  })

  test("accepting the Advanced defaults keeps the generated limits", async () => {
    const h = modelHarness({
      askResults: ["", "gpt-5", "sk", "", ""],
      pick: wizard({ limits: true }),
    })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured[0]).toMatchObject({ contextWindow: 128000, maxOutputTokens: 8192 })
  })

  test("a required model identifier is enforced", async () => {
    const h = modelHarness({ askResults: ["", ""], pick: wizard() })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured).toEqual([])
    expect(h.notices.at(-1)).toEqual({ text: "model identifier is required", isError: true })
  })

  test("a colliding generated id asks for a different local id instead of overwriting", async () => {
    const h = modelHarness({
      models: [{ id: "gpt-5" }],
      askResults: ["", "gpt-5", "sk", "gpt-5-eu"],
      pick: wizard(),
    })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured).toHaveLength(1)
    expect(h.calls.configured[0]!.id).toBe("gpt-5-eu")
    // The collision prompt names the clash, and the existing model is untouched.
    expect(h.asks.some(a => a.label.includes('"gpt-5" already exists'))).toBe(true)
  })

  test("a still-colliding replacement is rejected and re-asked", async () => {
    const h = modelHarness({
      models: [{ id: "gpt-5" }, { id: "gpt-5-eu" }],
      askResults: ["", "gpt-5", "sk", "gpt-5-eu", "gpt-5-eu-2"],
      pick: wizard(),
    })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured[0]!.id).toBe("gpt-5-eu-2")
  })

  test("cancelling the collision prompt leaves nothing added", async () => {
    const h = modelHarness({
      models: [{ id: "gpt-5" }],
      askResults: ["", "gpt-5", "sk", null],
      pick: wizard(),
    })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.calls.configured).toEqual([])
    expect(h.notices.at(-1)!.text).toBe("cancelled")
  })

  test("a configureModel failure is a normal error notice", async () => {
    const h = modelHarness({
      askResults: ["", "gpt-5", "sk"],
      pick: wizard(),
      failConfigure: new Error('model id "gpt-5" is already configured'),
    })
    await findCommand("model")!.execute(h.ctx, "add")
    expect(h.notices.at(-1)!.isError).toBe(true)
    expect(h.notices.at(-1)!.text).toContain("already configured")
  })

  test("/model with no models offers an actionable Add path", async () => {
    const h = modelHarness({
      models: [],
      askResults: ["", "gpt-5", "sk"],
      pick: call => {
        if (call.title === "Model") return byLabel(call, "Add model…")
        return wizard()(call)
      },
    })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.configured).toHaveLength(1)
  })
})

describe("/model edit wizard", () => {
  test("preserves id, name, endpoint, key, and limits when nothing is changed", async () => {
    const base = baseConfig({ id: "m1", name: "My Model", endpoint: "https://custom.example/v1" })
    const h = modelHarness({
      models: [{ id: "m1" }],
      active: "m1",
      configs: { m1: base },
      askResults: ["", "", ""],
      pick: wizard(),
    })
    await findCommand("model")!.execute(h.ctx, "edit m1")
    expect(h.calls.updated).toHaveLength(1)
    expect(h.calls.updated[0]).toEqual(base)
    expect(h.notices.at(-1)!.text).toBe('model "m1" updated')
  })

  test("the protocol picker opens on the current protocol", async () => {
    const base = baseConfig({ protocol: "anthropic" })
    const h = modelHarness({
      models: [{ id: "m1" }],
      configs: { m1: base },
      askResults: ["", "", ""],
      pick: wizard({ protocol: "anthropic" }),
    })
    await findCommand("model")!.execute(h.ctx, "edit m1")
    expect(h.picks.find(p => p.title === "Protocol")?.selectedValue).toBe("anthropic")
  })

  test("changing protocol falls back to the new protocol's default endpoint", async () => {
    const base = baseConfig({ protocol: "openai", endpoint: "https://custom.example/v1" })
    const h = modelHarness({
      models: [{ id: "m1" }],
      configs: { m1: base },
      askResults: ["", "", ""], // accept the shown endpoint default
      pick: wizard({ protocol: "anthropic" }),
    })
    await findCommand("model")!.execute(h.ctx, "edit m1")
    expect(h.calls.updated[0]).toMatchObject({
      protocol: "anthropic",
      endpoint: "https://api.anthropic.com/v1",
      id: "m1",
      name: "m1",
    })
  })

  test("overriding limits persists them while keeping identity and key", async () => {
    const base = baseConfig({ id: "m1", name: "Keep", apiKey: "sk-keep" })
    const h = modelHarness({
      models: [{ id: "m1" }],
      configs: { m1: base },
      askResults: ["", "", "", "200000", "16000"],
      pick: wizard({ limits: true }),
    })
    await findCommand("model")!.execute(h.ctx, "edit m1")
    expect(h.calls.updated[0]).toMatchObject({
      id: "m1",
      name: "Keep",
      apiKey: "sk-keep",
      contextWindow: 200000,
      maxOutputTokens: 16000,
    })
  })

  test("a blank API key preserves the existing credential", async () => {
    const base = baseConfig({ apiKey: "sk-existing" })
    const h = modelHarness({
      models: [{ id: "m1" }],
      configs: { m1: base },
      askResults: ["", "", ""],
      pick: wizard(),
    })
    await findCommand("model")!.execute(h.ctx, "edit m1")
    expect(h.calls.updated[0]!.apiKey).toBe("sk-existing")
  })

  test("a persistence failure on update is an error notice", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }],
      configs: { m1: baseConfig() },
      askResults: ["", "", ""],
      pick: wizard(),
      failUpdate: new Error("cannot persist model configuration to /x: EACCES"),
    })
    await findCommand("model")!.execute(h.ctx, "edit m1")
    expect(h.notices.at(-1)!.isError).toBe(true)
    expect(h.notices.at(-1)!.text).toContain("cannot persist")
  })
})

describe("/model selection and removal", () => {
  test("models exist: the picker lists them and a Configure models… action", async () => {
    const h = modelHarness({ models: [{ id: "m1" }, { id: "m2" }], active: "m1" })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.lastPickItems.map(i => i.label)).toEqual(["m1", "m2", "Configure models…"])
    expect(h.lastPickItems[0]!.description).toBe("active")
    expect(h.lastPickItems[1]!.description).toBeUndefined()
  })

  test("selecting a model activates it", async () => {
    const h = modelHarness({ models: [{ id: "m1" }, { id: "m2" }], active: "m1", pick: () => "m2" })
    await findCommand("model")!.execute(h.ctx, "")
    expect(h.calls.activated).toEqual(["m2"])
    expect(h.notices.at(-1)!.text).toBe("active model: m2")
  })

  test("direct selection by id activates it", async () => {
    const h = modelHarness({ models: [{ id: "m1" }, { id: "m2" }], active: "m1" })
    await findCommand("model")!.execute(h.ctx, "m2")
    expect(h.calls.activated).toEqual(["m2"])
  })

  test("Configure models… → Remove model… confirms, then removes a non-active model", async () => {
    const h = modelHarness({
      models: [{ id: "m1" }, { id: "m2" }],
      active: "m1",
      pick: call => {
        if (call.title === "Model") return byLabel(call, "Configure models…")
        if (call.title === "Configure models") return byLabel(call, "Remove model…")
        if (call.title === "Remove model" && call.items.some(i => i.value === "remove")) return "remove"
        if (call.title === "Remove model") return "m2"
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
      pick: call => {
        if (call.title === "Remove model" && call.items.some(i => i.value === "cancel")) return "cancel"
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
      pick: call => {
        if (call.title === "Remove model" && call.items.some(i => i.value === "remove")) return "remove"
        if (call.title === "Activate model") return "m2"
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
      pick: call => {
        if (call.title === "Remove model" && call.items.some(i => i.value === "remove")) return "remove"
        return null
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
      pick: call => {
        if (call.title === "Remove model" && call.items.some(i => i.value === "remove")) return "remove"
        return null
      },
    })
    await findCommand("model")!.execute(h.ctx, "remove m1")
    expect(h.calls.removed).toEqual(["m1"])
    expect(h.calls.activated).toEqual([])
    expect(h.notices.at(-1)!.text).toBe('removed model "m1"')
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
          if (call.title === "Protocol") return cancelAt === "protocol" ? null : byLabel(call, "OpenAI-compatible")
          if (call.title.startsWith("Add ")) return cancelAt === "commit" ? null : byLabel(call, "Add model")
          return null
        },
      })
      await findCommand("model")!.execute(h.ctx, "add")
      expect(h.calls.configured).toEqual([])
      expect(h.notices.at(-1)).toEqual({ text: "cancelled", isError: false })
    })
  }
})

