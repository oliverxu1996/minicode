import type { Session } from "../session/session"
import { trustProject } from "../config/trust"
import type { Skill } from "../config/resources"

/** Facade the commands act through — implemented by the TUI app. */
export interface CommandContext {
  agent(): import("../minicode").MiniCode
  session(): Session
  /** Replaces the active session (resume/fork/clone/new) and replays it. */
  setSession(session: Session): void
  /** Shows a notice / error line in the chat. */
  notify(text: string, isError?: boolean): void
  /** Opens an inline selector and resolves with the chosen value. */
  pick(title: string, items: Array<{ value: string; label: string; description?: string }>): Promise<string | null>
  /** Prompts for a single line of input (status-prompt style). */
  ask(label: string): Promise<string | null>
  /** Runs the model-based context compaction immediately. */
  compact(): Promise<boolean>
  /** Submits a task through the normal run path (used by templates). */
  submitTask(text: string): Promise<void>
  /** The skills currently available to the model. */
  skills(): Skill[]
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
    description: "Switch the active model",
    argumentHint: "[model-id]",
    async execute(ctx, args) {
      const agent = ctx.agent()
      if (args.trim().length > 0) {
        await agent.activateModel(args.trim())
        ctx.notify(`active model: ${args.trim()}`)
        return
      }
      const manager = await agent.modelManager()
      const models = manager.list()
      if (models.length === 0) {
        ctx.notify("no models configured — use /login to add one", true)
        return
      }
      const active = (await agent.currentModel())?.id
      const chosen = await ctx.pick(
        "Select model",
        models.map(m => ({
          value: m.id,
          label: m.id,
          description: m.id === active ? "active" : undefined,
        })),
      )
      if (chosen === null) return
      agent.activateModel(chosen)
      ctx.notify(`active model: ${chosen}`)
    },
  },
  {
    name: "login",
    description: "Configure a model (protocol, endpoint, credentials)",
    async execute(ctx) {
      const agent = ctx.agent()
      const protocol = (await ctx.ask("protocol — openai or anthropic:"))?.trim()
      if (protocol !== "openai" && protocol !== "anthropic") {
        ctx.notify("cancelled: protocol must be openai or anthropic", true)
        return
      }
      const defaultEndpoint =
        protocol === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1"
      const endpoint = (await ctx.ask(`endpoint (default ${defaultEndpoint}):`))?.trim() || defaultEndpoint
      const id = (await ctx.ask("model id (short name used by /model):"))?.trim()
      const model = (await ctx.ask("provider model name (e.g. gpt-4.1 / claude-sonnet-4-5):"))?.trim()
      const apiKey = await ctx.ask("api key:")
      const contextWindowRaw = (await ctx.ask("context window in tokens (default 128000):"))?.trim()
      const maxOutRaw = (await ctx.ask("max output tokens (default 8192):"))?.trim()
      if (!id || !model || apiKey === null) {
        ctx.notify("cancelled: missing fields", true)
        return
      }
      const contextWindow = Number(contextWindowRaw) > 0 ? Number(contextWindowRaw) : 128000
      const maxOutputTokens = Number(maxOutRaw) > 0 ? Number(maxOutRaw) : 8192
      await agent.configureModel({ id, name: id, protocol, endpoint, model, apiKey, contextWindow, maxOutputTokens })
      ctx.notify(`model "${id}" configured and activated`)
    },
  },
  {
    name: "logout",
    description: "Remove a configured model",
    async execute(ctx) {
      const agent = ctx.agent()
      const manager = await agent.modelManager()
      const models = manager.list()
      const chosen = await ctx.pick(
        "Remove model",
        models.map(m => ({ value: m.id, label: m.id })),
      )
      if (chosen === null) return
      agent.removeModel(chosen)
      ctx.notify(`removed model "${chosen}"`)
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
      const done = await ctx.compact()
      ctx.notify(done ? "context compacted" : "nothing to compact")
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
      session.replaceMessages(messages as import("@minicode/model").ModelMessage[])
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
      await ctx.agent().refreshRuntime()
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
      forked.replaceMessages(session.messages.slice(0, cut).map(m => ({ role: m.role, content: m.content })) as import("@minicode/model").ModelMessage[])
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
      clone.replaceMessages(session.messages.map(m => ({ role: m.role, content: m.content })) as import("@minicode/model").ModelMessage[])
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
          "enter — submit · shift+enter / ctrl+j — newline",
          "esc — interrupt the running task",
          "ctrl+c — clear input; twice within 500ms exits",
          "ctrl+d — exit (empty editor) · ctrl+o — expand tool output",
          "ctrl+p — cycle model · alt+enter — queue follow-up while running",
        ].join("\n"),
      )
    },
  },
  {
    name: "quit",
    description: "Exit MiniCode",
    execute() {
      process.exit(0)
    },
  },
]

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find(command => command.name === name)
}
