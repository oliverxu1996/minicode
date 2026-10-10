import type { CompactionOutcome, Session } from "@minicode/agent"
import type { ModelProtocol } from "@minicode/model"

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
  /** Replaces the active session (new/switch/fork/clone) and replays it. */
  setSession(session: Session): void
  /** Shows a notice / error line in the chat. */
  notify(text: string, isError?: boolean): void
  /** Opens an inline selector and resolves with the chosen value.
   *  `options.selectedValue` highlights an existing choice when it opens. */
  pick(
    title: string,
    items: Array<{ value: string; label: string; description?: string }>,
    options?: { selectedValue?: string },
  ): Promise<string | null>
  /** Prompts for a single line of input (status-prompt style). `secret` masks
   *  the typed text so credentials are never echoed. `initialValue` pre-fills
   *  the editor (used to seed a rename with the current title). */
  ask(label: string, options?: { secret?: boolean; initialValue?: string }): Promise<string | null>
  /**
   * Opens the interactive, workspace-scoped session manager (`/session`). The
   * application owns the whole interaction and all session mutations; this is
   * the command's only hook into it.
   */
  manageSessions(): Promise<void>
  /** Runs the model-based context compaction immediately. */
  compact(): Promise<CompactResult>
  /**
   * Opens the `/rewind` flow: pick a checkpoint, pick an action, apply it.
   * The application owns the interaction and the session mutation; this is the
   * command's only hook into it.
   */
  rewind(): Promise<void>
  /** Submits a task through the normal run path (used by templates). */
  submitTask(text: string): Promise<void>
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
  /** Syntax/documentation shown by `/help`, e.g. `<title>`. */
  readonly argumentHint?: string
  /**
   * User-facing inline UI copy shown as a muted ghost placeholder in the
   * composer while the command has no argument yet, e.g. `Name…`. Distinct
   * from `argumentHint`: it is presentation copy, not syntax, and is only set
   * for commands with a simple required argument.
   */
  readonly argumentPlaceholder?: string
  execute(ctx: CommandContext, args: string): Promise<void> | void
}

// ── model management (/model) ────────────────────────────────────────
//
// `/model` is the sole model surface: it opens a picker that selects the active
// model and offers `Add model…` as the only configuration action. The runtime
// store (ModelManager) is the source of truth for the configured models; these
// helpers only drive the picker/prompt interaction.

/** Picker action value for the `Add model…` row. Control-character prefixed so
 *  it can never collide with a user-chosen model id. */
const MODEL_ADD = "\u0000model:add"
/** Commit-picker actions for the wizard's final step. */
const MODEL_COMMIT = "\u0000model:commit"
const MODEL_LIMITS = "\u0000model:limits"

/**
 * MiniCode-managed limit defaults. The runtime needs *a* valid limit pair, not
 * the model's true maximum (contextWindow is never sent to the provider; it
 * only sizes MiniCode's own input/output budgets). These conservative values
 * let a user add a model without ever thinking about token limits.
 */
const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_OUTPUT_TOKENS = 8192

/** The two wire protocols MiniCode speaks, and the official endpoint each
 *  defaults to. Displayed as protocols, never as "providers". */
const PROTOCOL_ITEMS: Array<{ value: string; label: string }> = [
  { value: "openai", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic" },
]
const OFFICIAL_ENDPOINTS: Record<ModelProtocol, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
}

/** A user-facing message derived from a thrown value. Never contains secrets:
 *  ModelError messages carry no API key (see @minicode/model). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The values the wizard collects. Identity (`id`/`name`) and persistence are
 *  the caller's responsibility, so the wizard derives no id of its own. */
interface ModelDraft {
  readonly protocol: ModelProtocol
  readonly endpoint: string
  readonly model: string
  readonly apiKey: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

type ModelPromptResult =
  | { readonly kind: "draft"; readonly draft: ModelDraft }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly message: string }

/**
 * Derives the local configuration id from the provider model identifier, so the
 * user is never asked for a separate internal id. Control characters are
 * stripped (the picker reserves a control-character prefix for its own action
 * values); a name that reduces to nothing falls back to `"model"`.
 */
function deriveModelId(model: string): string {
  const cleaned = model.trim().replace(/[\u0000-\u001f\u007f]/g, "").trim()
  return cleaned.length > 0 ? cleaned : "model"
}

/**
 * Runs the guided add-model wizard.
 *
 * The normal path asks only for what MiniCode cannot reliably know — protocol,
 * endpoint, provider model, and API key. Context/output limits are MiniCode
 * defaults, reachable only through the optional `Configure limits…` action.
 *
 * Returns a discriminated result so the caller can report cancellation,
 * validation failure, and success distinctly — pressing Escape is never
 * reported as a validation error.
 */
async function promptModelDraft(ctx: CommandContext): Promise<ModelPromptResult> {
  const cancelled: ModelPromptResult = { kind: "cancelled" }
  const invalid = (message: string): ModelPromptResult => ({ kind: "error", message })

  const protocolChoice = await ctx.pick("Protocol", PROTOCOL_ITEMS)
  if (protocolChoice === null) return cancelled
  const protocol: ModelProtocol = protocolChoice === "anthropic" ? "anthropic" : "openai"

  // The endpoint defaults to the selected protocol's official base URL (shown,
  // and overridable).
  const endpointDefault = OFFICIAL_ENDPOINTS[protocol]
  const endpointRaw = await ctx.ask(`endpoint (default ${endpointDefault}):`)
  if (endpointRaw === null) return cancelled
  const endpoint = endpointRaw.trim() || endpointDefault

  const modelRaw = await ctx.ask("model (provider model id, e.g. gpt-5 / claude-sonnet-4-5):")
  if (modelRaw === null) return cancelled
  const model = modelRaw.trim()
  if (model.length === 0) return invalid("model identifier is required")

  const apiKeyRaw = await ctx.ask("api key:", { secret: true })
  if (apiKeyRaw === null) return cancelled
  const apiKey = apiKeyRaw.trim()

  // Limits always have a value; the user only sees them if they opt in.
  let contextWindow = DEFAULT_CONTEXT_WINDOW
  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS

  const action = await ctx.pick(`Add "${model}"`, [
    { value: MODEL_COMMIT, label: "Add model" },
    { value: MODEL_LIMITS, label: "Configure limits…" },
  ])
  if (action === null) return cancelled
  if (action === MODEL_LIMITS) {
    const contextRaw = await ctx.ask(`context window (default ${contextWindow}):`)
    if (contextRaw === null) return cancelled
    contextWindow = Number(contextRaw.trim()) > 0 ? Number(contextRaw.trim()) : contextWindow
    const maxOutRaw = await ctx.ask(`max output tokens (default ${maxOutputTokens}):`)
    if (maxOutRaw === null) return cancelled
    maxOutputTokens = Number(maxOutRaw.trim()) > 0 ? Number(maxOutRaw.trim()) : maxOutputTokens
  }

  return { kind: "draft", draft: { protocol, endpoint, model, apiKey, contextWindow, maxOutputTokens } }
}

/**
 * Resolves a generated id that collides with an existing model. Never invents a
 * silent suffix: the user supplies a different local id, or cancels. Returns the
 * accepted id, or null when the user cancels.
 */
async function resolveModelIdCollision(
  ctx: CommandContext,
  taken: string,
  existing: ReadonlySet<string>,
): Promise<string | null> {
  let candidate = taken
  while (true) {
    const raw = await ctx.ask(`model "${candidate}" already exists — enter a different local model id:`)
    if (raw === null) return null
    const next = raw.trim()
    if (next.length === 0) {
      ctx.notify("local model id is required", true)
      continue
    }
    if (next.startsWith("\u0000")) {
      ctx.notify("invalid local model id", true)
      continue
    }
    if (existing.has(next)) {
      ctx.notify(`model "${next}" already exists`, true)
      candidate = next
      continue
    }
    return next
  }
}

/** Configures and activates a new model, deriving its local id from the model. */
async function addModel(ctx: CommandContext): Promise<void> {
  const result = await promptModelDraft(ctx)
  if (result.kind === "cancelled") {
    ctx.notify("cancelled")
    return
  }
  if (result.kind === "error") {
    ctx.notify(result.message, true)
    return
  }

  const manager = await ctx.agent().modelManager()
  const existing = new Set(manager.list().map(m => m.id))
  let id = deriveModelId(result.draft.model)
  if (existing.has(id)) {
    const resolved = await resolveModelIdCollision(ctx, id, existing)
    if (resolved === null) {
      ctx.notify("cancelled")
      return
    }
    id = resolved
  }

  try {
    await ctx.agent().configureModel({ id, name: id, ...result.draft })
    ctx.notify(`model "${id}" configured and activated`)
  } catch (error) {
    ctx.notify(`cannot configure model: ${errorMessage(error)}`, true)
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
    description: "Select or add a model",
    async execute(ctx, args) {
      // `/model` takes no arguments. The former `add`/`edit`/`remove` forms and
      // direct model-id activation are gone; any argument is rejected rather
      // than silently reinterpreted.
      if (args.trim().length > 0) {
        ctx.notify("usage: /model", true)
        return
      }

      const agent = ctx.agent()
      const models = (await agent.modelManager()).list()
      const active = (await agent.currentModel())?.id

      // A single picker covers both capabilities: every configured model, plus
      // `Add model…`. With no configured models it collapses to the Add row,
      // so the wizard is always reachable.
      const chosen = await ctx.pick("Model", [
        ...models.map(m => ({
          value: m.id,
          label: m.id,
          description: m.id === active ? "active" : undefined,
        })),
        { value: MODEL_ADD, label: "Add model…" },
      ])
      if (chosen === null) return
      if (chosen === MODEL_ADD) {
        await addModel(ctx)
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
    name: "new",
    description: "Start a fresh session in the same workspace",
    execute(ctx) {
      const session = ctx.agent().createSession(ctx.session().cwd)
      ctx.setSession(session)
      ctx.notify("started a new session")
    },
  },
  {
    name: "session",
    description: "Manage sessions in this workspace",
    execute(ctx) {
      return ctx.manageSessions()
    },
  },
  {
    name: "rewind",
    description: "Restore the conversation, files, or both to an earlier prompt",
    async execute(ctx) {
      await ctx.rewind()
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
          ctx.notify("no model configured — use /model to add one", true)
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
