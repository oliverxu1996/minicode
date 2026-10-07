import { join } from "node:path"
import { ModelManager, type Model, type ModelConfig } from "@minicode/model"
import { Session } from "./session/session"
import { SessionStore } from "./session/store"
import type { RunEvent } from "./loop/events"
import type { SessionStatus } from "./session/types"
import { CODING_TOOLS } from "./tools"
import { runTask, type RunResult } from "./loop/run"
import { loadSettings } from "./config/settings"
import { isProjectTrusted } from "./config/trust"
import { formatProjectInstructions, loadProjectContext } from "./config/context"
import { loadResources } from "./config/resources"
import { configDir } from "./config/dir"

export interface MiniCodeOptions {
  /** Session storage directory. Defaults to `~/.minicode/sessions` — sessions
   *  are kept out of the target repository. */
  sessionsDir?: string
  /** Model override. Defaults to the active model resolved LIVE from
   *  `@minicode/model` ModelManager at each run. */
  model?: Model
}

/**
 * MiniCode — the Coding Agent runtime root.
 *
 * Owns session storage and the default model resolution; every execution
 * flows through `run()`. v0.1 is autonomous: tools are auto-approved, one
 * session works one repository (the session's cwd), and the fixed coding
 * toolset (read/write/edit/grep/find/ls/bash) is always available.
 */
export class MiniCode {
  readonly store: SessionStore
  private readonly modelOverride: Model | undefined
  private readonly sessions = new Map<string, Session>()

  constructor(options: MiniCodeOptions = {}) {
    this.store = new SessionStore(options.sessionsDir ?? defaultSessionsDir())
    this.modelOverride = options.model
  }

  /** Creates a session for one target repository. */
  createSession(cwd: string): Session {
    const session = Session.create({ cwd })
    this.track(session)
    return session
  }

  /** Restores a persisted session; pending tool calls are reconciled by the
   *  next run, before the model is invoked. */
  async loadSession(id: string): Promise<Session> {
    const existing = this.sessions.get(id)
    if (existing) return existing
    const json = await this.store.read(id) as Record<string, unknown>
    const session = Session.fromJSON(json)
    this.track(session)
    return session
  }

  /**
   * Executes one autonomous coding task against a session. The model is
   * resolved live (the injected override, else the configured active model)
   * so configuration changes apply to the next run without restarting.
   */
  async run(
    session: Session,
    task: string,
    opts: {
      signal?: AbortSignal
      maxIterations?: number
      autoRetryDelayMs?: number
      onEvent?: (event: RunEvent) => void
    } = {},
  ): Promise<RunResult> {
    const model = this.modelOverride ?? await this.resolveModel()
    // Project context, settings, and resources load per run so edits apply
    // without restarting.
    const settings = loadSettings(session.cwd)
    const trusted = isProjectTrusted(session.cwd)
    const resources = loadResources(session.cwd, trusted)
    const contextFile = loadProjectContext(session.cwd)
    const projectInstructions = formatProjectInstructions(contextFile)

    return runTask({
      session,
      model,
      task,
      signal: opts.signal,
      maxIterations: opts.maxIterations,
      autoRetryDelayMs: opts.autoRetryDelayMs,
      projectInstructions,
      skills: resources.skills,
      autoCompact: settings.settings.autoCompact,
      onEvent: opts.onEvent,
    })
  }

  private async resolveModel(): Promise<Model> {
    const model = await this.currentModel()
    if (model === undefined) {
      throw new Error(
        "No active model configured. Create " +
          `${join(configDir(), "models.json")} ` +
          'with {"version":1,"models":[{"id":"…","name":"…","protocol":"openai"|"anthropic","endpoint":"…","model":"…","apiKey":"…","contextWindow":128000,"maxOutputTokens":8192}],"activeModelId":"…"} ' +
          "and restart, or pass a Model to new MiniCode({ model }).",
      )
    }
    return model
  }

  /** The model a run would use right now (override, else the configured
   *  active model), or undefined when nothing is configured. */
  async currentModel(): Promise<Model | undefined> {
    if (this.modelOverride !== undefined) return this.modelOverride
    const manager = await ModelManager.load()
    return manager.active()
  }

  /** The persisted model configuration manager (model lifecycle commands). */
  async modelManager(): Promise<ModelManager> {
    return ModelManager.load()
  }

  /** Activates a configured model by id (persists). */
  async activateModel(id: string): Promise<void> {
    const manager = await ModelManager.load()
    manager.activate(id)
  }

  /** Removes a configured model (persists). */
  removeModel(id: string): void {
    void (async () => {
      const manager = await ModelManager.load()
      manager.remove(id)
    })()
  }

  /** Adds and activates a model configuration (persists). */
  async configureModel(config: import("@minicode/model").ModelConfig): Promise<void> {
    const manager = await ModelManager.load()
    manager.add(config)
    manager.activate(config.id)
  }

  /** Summaries of every persisted session (for resume/tree UIs). */
  async sessionSummaries(): Promise<Array<{
    id: string
    cwd: string
    /**
     * True when the snapshot actually persisted a `cwd`. `Session.fromJSON`
     * defaults a missing `cwd` to the loading process's directory, so a
     * consumer that scopes by workspace needs to distinguish a real path from
     * that fallback.
     */
    cwdPresent: boolean
    title: string | null
    parentSessionId: string | null
    updatedAt: number
    messageCount: number
    firstUser: string | null
  }>> {
    const out: Array<{
      id: string
      cwd: string
      cwdPresent: boolean
      title: string | null
      parentSessionId: string | null
      updatedAt: number
      messageCount: number
      firstUser: string | null
    }> = []
    for (const id of await this.store.list()) {
      try {
        // The same validating parser the rest of the runtime uses. A summary
        // is a view of a session, so it must not be a second, unchecked
        // interpretation of the persisted format — the picker's counts and
        // titles could otherwise disagree with the session actually loaded.
        const raw = await this.store.read(id) as Record<string, unknown>
        const session = Session.fromJSON(raw)
        const firstUser = session.messages.find(m => m.role === "user")
        out.push({
          id: session.id,
          cwd: session.cwd,
          cwdPresent: typeof raw.cwd === "string",
          title: session.title,
          parentSessionId: session.parentSessionId,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length,
          firstUser: firstUser !== undefined && typeof firstUser.content === "string"
            ? firstUser.content.slice(0, 60)
            : null,
        })
      } catch {
        // Unreadable or invalid session — skip.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Deletes a persisted session for good: removes its snapshot and any
   * in-memory instance. Eviction matters because `loadSession` returns a
   * cached `Session`, so deleting only the file would let a later load
   * resurrect the session from memory.
   */
  async deleteSession(id: string): Promise<void> {
    await this.store.delete(id)
    this.sessions.delete(id)
  }

  private track(session: Session): void {
    this.sessions.set(session.id, session)
    session.onCheckpoint(async () => {
      await this.store.saveJSON(session.id, JSON.stringify(session.toJSON(), null, 2))
    })
  }
}

function defaultSessionsDir(): string {
  return join(configDir(), "sessions")
}

export type { RunResult } from "./loop/run"
export type { SessionStatus } from "./session/types"
export type { Session }
