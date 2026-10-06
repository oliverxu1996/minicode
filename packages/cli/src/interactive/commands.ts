import type { CompactionOutcome, Session, Skill } from "@minicode/agent"
import { trustProject } from "@minicode/agent"
import type { ModelConfig } from "@minicode/model"

/**
 * Outcome of a manual `/compact`, including cases the compaction layer cannot
 * report on its own: no model configured, and a compaction already in flight.
 *
 * Deliberately a union rather than a boolean: "nothing to compact", "no model",
 * "already running" and "compaction failed" must not render the same message.
 */
export type CompactResult =
  | CompactionOutcome
  | { readonly status: "no-model" }
  | { readonly status: "busy"; readonly reason: "compacting" | "running" }

/** Facade the commands act through — implemented by the TUI app. */
export interface CommandContext {
  agent(): import("@minicode/agent").MiniCode
  session(): Session
  /** Replaces the active session (resume/fork/clone/new) and replays it. */
  setSession(session: Session): void
  /** Shows a notice / error line in the chat. */
  notify(text: string, isError?: boolean): void
  /** Opens an inline selector and resolves with the chosen value. */
  pick(title: string, items: Array<{ value: string; label: string; description?: string }>): Promise<string | null>
  /** Prompts for a single line of input (status-prompt style). `secret` masks
   *  the typed text so credentials are never echoed. */
  ask(label: string, options?: { secret?: boolean }): Promise<string | null>
  /** Runs the model-based context compaction immediately. */
  compact(): Promise<CompactResult>
  /** Submits a task through the normal run path (used by templates). */
  submitTask(text: string): Promise<void>
  /** The skills currently available to the model. */
  skills(): Skill[]
  /**
   * Re-reads project settings, context, prompts and skills into the UI's own
   * caches. The runtime reloads these per run already; this exists for the
   * copies the TUI holds (prompt templates, the skill list), which otherwise
   * stay as they were when the app started.
   */
  reloadResources(): void
  /**
   * Shuts the UI down through its own lifecycle (leaving the fullscreen screen
   * and restoring the terminal) before exiting. Commands must use this rather
   * than calling `process.exit` directly.
   */
  quit(): void
}

export interface Command {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  execute(ctx: CommandContext, args: string): Promise<void> | void
}

async function pickSession(ctx: CommandContext, filter?: (session: Session) => boolean): Promise<Session | null> {
  const summaries = await ctx.agent().sessionSummaries()
  const current = ctx.session()
  const items = summaries
    .filter(s => s.id !== current.id)
    .filter(s => (filter ? filter({ id: s.id } as Session) : true))
    .map(s => ({
      value: s.id,
      label: s.title ?? s.firstUser ?? "(untitled)",
      description: `${s.messageCount} msgs · ${new Date(s.updatedAt).toLocaleString()}`,
    }))
  if (items.length === 0) {
    ctx.notify("no other sessions found")
    return null
  }
  const chosen = await ctx.pick("Resume session", items)
  if (chosen === null) return null
  return ctx.agent().loadSession(chosen)
}

function exportPath(session: Session, path: string | undefined): string {
  if (path !== undefined && path.trim().length > 0) return path.trim()
  const short = session.id.slice(0, 8)
  return `${session.cwd}/minicode-session-${short}.jsonl`
}

// ── model management (/model) ────────────────────────────────────────
//
// The user-facing concept is the configured Model, not a login: `/model`
// selects the active model and is the single entry point for adding, editing,
// and removing configurations. The runtime store (ModelManager) is the source
// of truth; these helpers only drive the picker/prompt interaction.

/** Picker action values. Control-character prefixed so they can never collide
 *  with a user-chosen model id. */
const MODEL_ADD = "\u0000model:add"
const MODEL_EDIT = "\u0000model:edit"
const MODEL_REMOVE = "\u0000model:remove"
const MODEL_CONFIGURE = "\u0000model:configure"

/** A user-facing message derived from a thrown value. Never contains secrets:
 *  ModelError messages carry no API key (see @minicode/model). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ModelPromptResult =
  | { readonly kind: "config"; readonly config: ModelConfig }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly message: string }

/** Picker over the configured models. Returns the chosen id, or null when there
 *  are none or the user cancels. */
async function pickModelId(ctx: CommandContext, title: string): Promise<string | null> {
  const models = (await ctx.agent().modelManager()).list()
  if (models.length === 0) return null
  const active = (await ctx.agent().currentModel())?.id
  return ctx.pick(title, models.map(m => ({
    value: m.id,
    label: m.id,
    description: m.id === active ? "active" : undefined,
  })))
}

/**
 * Runs the model-configuration prompts. `base` seeds an edit with the current
 * values; when absent the flow adds a new model. Returns a discriminated result
 * so the caller can report cancellation, validation failure, and success
 * distinctly — pressing Escape is never reported as a validation error.
 */
async function promptModelConfig(ctx: CommandContext, base?: ModelConfig): Promise<ModelPromptResult> {
  const editing = base !== undefined
  const cancelled: ModelPromptResult = { kind: "cancelled" }
  const invalid = (message: string): ModelPromptResult => ({ kind: "error", message })

  const protocolRaw = await ctx.ask(editing ? `protocol (default ${base.protocol}):` : "protocol — openai or anthropic:")
  if (protocolRaw === null) return cancelled
  const protocol = protocolRaw.trim() || (editing ? base.protocol : "")
  if (protocol !== "openai" && protocol !== "anthropic") {
    return invalid("protocol must be openai or anthropic")
  }

  const defaultEndpoint = protocol === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1"
  const endpointDefault = editing && base.protocol === protocol ? base.endpoint : defaultEndpoint
  const endpointRaw = await ctx.ask(`endpoint (default ${endpointDefault}):`)
  if (endpointRaw === null) return cancelled
  const endpoint = endpointRaw.trim() || endpointDefault

  let id: string
  if (editing) {
    // `ModelManager.update` replaces the configuration of an existing id; the
    // id is the identity and is not changed by an edit.
    id = base.id
  } else {
    const idRaw = await ctx.ask("model id (short name used by /model):")
    if (idRaw === null) return cancelled
    id = idRaw.trim()
    if (id.length === 0) return invalid("model id is required")
  }

  const modelRaw = await ctx.ask(editing
    ? `provider model name (default ${base.model}):`
    : "provider model name (e.g. gpt-4.1 / claude-sonnet-4-5):")
  if (modelRaw === null) return cancelled
  const model = modelRaw.trim() || (editing ? base.model : "")
  if (model.length === 0) return invalid("provider model name is required")

  const apiKeyRaw = await ctx.ask(editing ? "api key (blank keeps current):" : "api key:", { secret: true })
  if (apiKeyRaw === null) return cancelled
  const apiKey = apiKeyRaw.trim().length === 0 ? (editing ? base.apiKey : "") : apiKeyRaw.trim()

  const contextRaw = await ctx.ask(`context window in tokens (default ${editing ? base.contextWindow : 128000}):`)
  if (contextRaw === null) return cancelled
  const contextWindow = Number(contextRaw.trim()) > 0 ? Number(contextRaw.trim()) : (editing ? base.contextWindow : 128000)

  const maxOutRaw = await ctx.ask(`max output tokens (default ${editing ? base.maxOutputTokens : 8192}):`)
  if (maxOutRaw === null) return cancelled
  const maxOutputTokens = Number(maxOutRaw.trim()) > 0 ? Number(maxOutRaw.trim()) : (editing ? base.maxOutputTokens : 8192)

  return {
    kind: "config",
    config: { id, name: editing ? base.name : id, protocol, endpoint, model, apiKey, contextWindow, maxOutputTokens },
  }
}

/** Configures and activates a new model. */
async function addModel(ctx: CommandContext): Promise<void> {
  const result = await promptModelConfig(ctx)
  if (result.kind === "cancelled") {
    ctx.notify("cancelled")
    return
  }
  if (result.kind === "error") {
    ctx.notify(result.message, true)
    return
  }
  try {
    await ctx.agent().configureModel(result.config)
    ctx.notify(`model "${result.config.id}" configured and activated`)
  } catch (error) {
    ctx.notify(`cannot configure model: ${errorMessage(error)}`, true)
  }
}

/** Replaces an existing model's configuration via `ModelManager.update`. */
async function editModel(ctx: CommandContext, id: string): Promise<void> {
  const base = (await ctx.agent().modelManager()).config(id)
  if (base === undefined) {
    ctx.notify(`model "${id}" is not configured`, true)
    return
  }
  const result = await promptModelConfig(ctx, base)
  if (result.kind === "cancelled") {
    ctx.notify("cancelled")
    return
  }
  if (result.kind === "error") {
    ctx.notify(result.message, true)
    return
  }
  try {
    // Re-read the manager so the update is applied to the latest state.
    ;(await ctx.agent().modelManager()).update(result.config)
    ctx.notify(`model "${result.config.id}" updated`)
  } catch (error) {
    ctx.notify(`cannot update model: ${errorMessage(error)}`, true)
  }
}

/** Explicit confirmation before a removal. */
async function confirmRemoval(ctx: CommandContext, id: string): Promise<boolean> {
  const choice = await ctx.pick("Remove model", [
    { value: "remove", label: `Remove "${id}"` },
    { value: "cancel", label: "Cancel" },
  ])
  return choice === "remove"
}

/**
 * Removes a model after confirmation. Removing the active model while others
 * remain requires the user to pick the replacement explicitly; cancelling that
 * choice abandons the removal rather than leaving an arbitrary active model.
 * Removing the last model leaves no active model, which is valid.
 */
async function removeModel(ctx: CommandContext, id: string): Promise<void> {
  const models = (await ctx.agent().modelManager()).list()
  if (!models.some(m => m.id === id)) {
    ctx.notify(`model "${id}" is not configured`, true)
    return
  }
  if (!(await confirmRemoval(ctx, id))) {
    ctx.notify("cancelled")
    return
  }

  const active = (await ctx.agent().currentModel())?.id
  const remaining = models.filter(m => m.id !== id)
  let replacement: string | null = null
  if (id === active && remaining.length > 0) {
    replacement = await ctx.pick("Activate model", remaining.map(m => ({ value: m.id, label: m.id })))
    if (replacement === null) {
      ctx.notify("cancelled")
      return
    }
  }

  try {
    const manager = await ctx.agent().modelManager()
    manager.remove(id)
    if (replacement !== null) manager.activate(replacement)
    ctx.notify(replacement !== null
      ? `removed model "${id}" — active model: ${replacement}`
      : `removed model "${id}"`)
  } catch (error) {
    ctx.notify(`cannot remove model: ${errorMessage(error)}`, true)
  }
}

/** The Configure submenu, shared by `/model` and the add/edit/remove paths. */
async function openConfigureMenu(ctx: CommandContext): Promise<void> {
  const models = (await ctx.agent().modelManager()).list()
  const items: Array<{ value: string; label: string }> = [{ value: MODEL_ADD, label: "Add model…" }]
  if (models.length > 0) {
    items.push({ value: MODEL_EDIT, label: "Edit model…" })
    items.push({ value: MODEL_REMOVE, label: "Remove model…" })
  }
  const action = await ctx.pick("Configure models", items)
  if (action === MODEL_ADD) {
    await addModel(ctx)
  } else if (action === MODEL_EDIT) {
    const id = await pickModelId(ctx, "Edit model")
    if (id !== null) await editModel(ctx, id)
  } else if (action === MODEL_REMOVE) {
    const id = await pickModelId(ctx, "Remove model")
    if (id !== null) await removeModel(ctx, id)
  }
}

export const COMMANDS: Command[] = [
  {
    name: "help",
    description: "Show available commands",
    execute(ctx) {
      const lines = COMMANDS.map(c => {
        const args = c.argumentHint !== undefined ? ` ${c.argumentHint}` : ""
        return `/${c.name}${args} — ${c.description}`
      })
      ctx.notify(`Commands:\n${lines.join("\n")}`)
    },
  },
  {
    name: "model",
    description: "Select, add, edit, or remove models",
    argumentHint: "[add | edit <id> | remove <id> | <model-id>]",
    async execute(ctx, args) {
      const agent = ctx.agent()
      const trimmed = args.trim()

      if (trimmed === "add") {
        await addModel(ctx)
        return
      }
      if (trimmed === "edit" || trimmed.startsWith("edit ")) {
        const id = trimmed.slice("edit".length).trim()
        if (id.length === 0) {
          ctx.notify("usage: /model edit <model-id>", true)
          return
        }
        await editModel(ctx, id)
        return
      }
      if (trimmed === "remove" || trimmed.startsWith("remove ")) {
        const id = trimmed.slice("remove".length).trim()
        if (id.length === 0) {
          ctx.notify("usage: /model remove <model-id>", true)
          return
        }
        await removeModel(ctx, id)
        return
      }
      // Direct selection by id.
      if (trimmed.length > 0) {
        try {
          await agent.activateModel(trimmed)
          ctx.notify(`active model: ${trimmed}`)
        } catch (error) {
          ctx.notify(`cannot activate model: ${errorMessage(error)}`, true)
        }
        return
      }

      const models = (await agent.modelManager()).list()
      // An empty store must offer an actionable path, not an unusable picker.
      if (models.length === 0) {
        const action = await ctx.pick("Model", [{ value: MODEL_ADD, label: "Add model…" }])
        if (action === MODEL_ADD) await addModel(ctx)
        return
      }

      const active = (await agent.currentModel())?.id
      const chosen = await ctx.pick("Model", [
        ...models.map(m => ({
          value: m.id,
          label: m.id,
          description: m.id === active ? "active" : undefined,
        })),
        { value: MODEL_CONFIGURE, label: "Configure models…" },
      ])
      if (chosen === null) return
      if (chosen === MODEL_CONFIGURE) {
        await openConfigureMenu(ctx)
        return
      }
      try {
        await agent.activateModel(chosen)
        ctx.notify(`active model: ${chosen}`)
      } catch (error) {
        ctx.notify(`cannot activate model: ${errorMessage(error)}`, true)
      }
    },
  },
  {
    name: "login",
    description: "Deprecated alias for /model add",
    async execute(ctx) {
      ctx.notify("login is deprecated — use /model add")
      await addModel(ctx)
    },
  },
  {
    name: "logout",
    description: "Deprecated alias for /model remove",
    async execute(ctx) {
      ctx.notify("logout is deprecated — use /model remove")
      const id = await pickModelId(ctx, "Remove model")
      if (id !== null) await removeModel(ctx, id)
    },
  },
  {
    name: "new",
    description: "Start a fresh session in the same workspace",
    execute(ctx) {
      const session = ctx.agent().createSession(ctx.session().cwd)
      ctx.setSession(session)
      ctx.notify("started a new session")
    },
  },
  {
    name: "resume",
    description: "Resume a previous session",
    async execute(ctx) {
      const other = await pickSession(ctx)
      if (other !== null) {
        ctx.setSession(other)
        ctx.notify(`resumed session ${other.id.slice(0, 8)}`)
      }
    },
  },
  {
    name: "name",
    description: "Name the current session",
    argumentHint: "<title>",
    async execute(ctx, args) {
      const title = args.trim()
      if (title.length === 0) {
        ctx.notify("usage: /name <title>", true)
        return
      }
      await ctx.session().setTitle(title)
      ctx.notify(`session named: ${title}`)
    },
  },
  {
    name: "session",
    description: "Show session info and stats",
    execute(ctx) {
      const s = ctx.session()
      const tools = s.ledger.all.length
      const ok = s.ledger.all.filter(e => e.status === "succeeded").length
      ctx.notify(
        [
          `session ${s.id.slice(0, 8)} · ${s.status} · cwd ${s.cwd}`,
          `messages: ${s.messages.length} · tool calls: ${tools} (${ok} succeeded)`,
          s.title !== null ? `title: ${s.title}` : "untitled",
        ].join("\n"),
      )
    },
  },
  {
    name: "compact",
    description: "Manually compact the session context",
    async execute(ctx) {
      const result = await ctx.compact()
      switch (result.status) {
        case "compacted":
          ctx.notify(`context compacted — ${result.removed} messages summarized`)
          break
        case "no-progress":
          ctx.notify("nothing to compact")
          break
        case "failed":
          ctx.notify(`compaction failed: ${result.error}`, true)
          break
        case "no-model":
          ctx.notify("no model configured — use /model add", true)
          break
        case "busy":
          ctx.notify(result.reason === "running"
            ? "a task is running — wait for it to finish before compacting"
            : "a compaction is already in progress")
          break
      }
    },
  },
  {
    name: "copy",
    description: "Copy the last agent response to the clipboard (OSC52)",
    execute(ctx) {
      const last = ctx.session().lastAssistant()
      const text = last === undefined
        ? ""
        : last.content.filter(p => p.type === "text").map(p => p.text).join("")
      if (text.trim().length === 0) {
        ctx.notify("no agent response to copy", true)
        return
      }
      const encoded = Buffer.from(text, "utf-8").toString("base64")
      process.stdout.write(`\x1b]52;c;${encoded}\x07`)
      ctx.notify("last response copied to the system clipboard")
    },
  },
  {
    name: "export",
    description: "Export the session to a JSONL file",
    argumentHint: "[path]",
    async execute(ctx, args) {
      const path = exportPath(ctx.session(), args.trim().length > 0 ? args : undefined)
      const lines = ctx.session().messages.map(m => JSON.stringify({ role: m.role, content: m.content, timestamp: m.timestamp }))
      const { writeFileSync } = await import("node:fs")
      writeFileSync(path, lines.join("\n") + "\n", "utf-8")
      ctx.notify(`session exported to ${path}`)
    },
  },
  {
    name: "import",
    description: "Import a session from a JSONL file into a new session",
    argumentHint: "<path>",
    async execute(ctx, args) {
      const path = args.trim()
      if (path.length === 0) {
        ctx.notify("usage: /import <path>", true)
        return
      }
      const { readFileSync } = await import("node:fs")
      let messages: Array<{ role: string; content: unknown }>
      try {
        messages = readFileSync(path, "utf-8")
          .split("\n")
          .filter(l => l.trim().length > 0)
          .map(l => JSON.parse(l))
      } catch (err) {
        ctx.notify(`import failed: ${err instanceof Error ? err.message : err}`, true)
        return
      }
      const session = ctx.agent().createSession(ctx.session().cwd)
      await session.replaceMessages(messages as import("@minicode/model").ModelMessage[])
      ctx.setSession(session)
      ctx.notify(`imported ${messages.length} messages into session ${session.id.slice(0, 8)}`)
    },
  },
  {
    name: "trust",
    description: "Trust this project's local resources (prompts, skills)",
    execute(ctx) {
      trustProject(ctx.session().cwd)
      ctx.notify("project trusted — project prompts and skills are now loaded (use /reload)")
    },
  },
  {
    name: "reload",
    description: "Reload settings, project context, prompts, and skills",
    async execute(ctx) {
      // The runtime reads settings/context/resources per run, so nothing there
      // needs refreshing; the TUI's own cached copies do. Refresh those, then
      // the confirmation below is true rather than merely printed.
      ctx.reloadResources()
      ctx.notify("reloaded settings, project context, prompts, and skills")
    },
  },
  {
    name: "fork",
    description: "Fork a new session from a previous user message",
    async execute(ctx) {
      const session = ctx.session()
      const userMessages = session.messages
        .map((m, index) => ({ m, index }))
        .filter(entry => entry.m.role === "user")
      if (userMessages.length === 0) {
        ctx.notify("nothing to fork yet", true)
        return
      }
      const chosen = await ctx.pick(
        "Fork from message",
        userMessages.map(entry => ({
          value: String(entry.index),
          label: (entry.m as { content: string }).content.slice(0, 60),
          description: `#${entry.index + 1}`,
        })),
      )
      if (chosen === null) return
      const cut = Number(chosen) + 1
      const forked = ctx.agent().createSession(session.cwd)
      forked.parentSessionId = session.id
      await forked.replaceMessages(session.messages.slice(0, cut).map(m => ({ role: m.role, content: m.content })) as import("@minicode/model").ModelMessage[])
      ctx.setSession(forked)
      ctx.notify(`forked session ${forked.id.slice(0, 8)} from message #${cut}`)
    },
  },
  {
    name: "clone",
    description: "Duplicate the current session",
    async execute(ctx) {
      const session = ctx.session()
      const clone = ctx.agent().createSession(session.cwd)
      clone.parentSessionId = session.id
      await clone.replaceMessages(session.messages.map(m => ({ role: m.role, content: m.content })) as import("@minicode/model").ModelMessage[])
      ctx.setSession(clone)
      ctx.notify(`cloned into session ${clone.id.slice(0, 8)}`)
    },
  },
  {
    name: "tree",
    description: "Navigate sessions forked from this one",
    async execute(ctx) {
      const current = ctx.session()
      const related = (await ctx.agent().sessionSummaries())
        .filter(s => s.parentSessionId === current.id)
      if (related.length === 0) {
        ctx.notify("no forked sessions under this one")
        return
      }
      const chosen = await ctx.pick(
        "Forked sessions",
        related.map(s => ({
          value: s.id,
          label: s.title ?? s.firstUser ?? s.id.slice(0, 8),
          description: `${s.messageCount} msgs`,
        })),
      )
      if (chosen === null) return
      ctx.setSession(await ctx.agent().loadSession(chosen))
      ctx.notify("switched session")
    },
  },
  {
    name: "hotkeys",
    description: "Show keyboard shortcuts",
    execute(ctx) {
      ctx.notify(
        [
          "enter — submit · alt+enter / shift+enter / ctrl+j — newline",
          "esc — interrupt the running task",
          "ctrl+c — clear input; twice within 500ms exits",
          "ctrl+d — exit (empty editor) · ctrl+o — expand tool output",
          "ctrl+p — cycle model",
        ].join("\n"),
      )
    },
  },
  {
    name: "quit",
    description: "Exit MiniCode",
    execute(ctx) {
      ctx.quit()
    },
  },
]

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find(command => command.name === name)
}
