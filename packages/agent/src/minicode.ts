import { homedir } from "node:os"
import { join } from "node:path"
import { ModelManager, type Model } from "@minicode/model"
import { Session } from "./session/session"
import { SessionStore } from "./session/store"
import type { RunEvent, SessionStatus } from "./session/types"
import { CODING_TOOLS } from "./tools"
import { runTask, type RunResult } from "./loop/run"

export interface MiniCodeOptions {
  /** Session storage directory. Defaults to
   *  `XDG_CONFIG_HOME ?? ~/.config` + `/minicode/sessions` — sessions are
   *  kept out of the target repository. */
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
    opts: { signal?: AbortSignal; maxIterations?: number; onEvent?: (event: RunEvent) => void } = {},
  ): Promise<RunResult> {
    const model = this.modelOverride ?? await this.resolveModel()
    return runTask({
      session,
      model,
      task,
      signal: opts.signal,
      maxIterations: opts.maxIterations,
      onEvent: opts.onEvent,
    })
  }

  private async resolveModel(): Promise<Model> {
    const manager = await ModelManager.load()
    const model = manager.active()
    if (model === undefined) {
      throw new Error(
        "No active model configured. Add one via @minicode/model ModelManager (add + activate).",
      )
    }
    return model
  }

  /** Display label of the model a run would use right now. */
  async currentModelLabel(): Promise<string> {
    if (this.modelOverride !== undefined) return this.modelOverride.id
    const manager = await ModelManager.load()
    return manager.active()?.id ?? "no model"
  }

  private track(session: Session): void {
    this.sessions.set(session.id, session)
    session.onCheckpoint(async () => {
      await this.store.saveJSON(session.id, JSON.stringify(session.toJSON(), null, 2))
    })
  }
}

function defaultSessionsDir(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(base, "minicode", "sessions")
}

export type { RunResult } from "./loop/run"
export type { SessionStatus } from "./session/types"
export type { Session }
