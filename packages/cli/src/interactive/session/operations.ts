import type { MiniCode, Session } from "@minicode/agent"
import type { ModelMessage } from "@minicode/model"

/**
 * Session derivation operations for the `/session` manager.
 *
 * These preserve the semantics the removed `/fork` and `/clone` commands had:
 * a child session in the parent's workspace, `parentSessionId` recorded, and
 * only message `role`/`content` copied through the durable `replaceMessages`
 * door (never runs, ledger, message ids, statuses, or timestamps).
 */

/** One selectable cut point for `/fork`, oldest user message first. */
export interface ForkCandidate {
  readonly index: number
  readonly label: string
  readonly description: string
}

/** The user messages of `session`, in order, as fork cut points. */
export function forkCandidates(session: Session): ForkCandidate[] {
  const out: ForkCandidate[] = []
  session.messages.forEach((message, index) => {
    if (message.role !== "user") return
    out.push({
      index,
      label: typeof message.content === "string" ? message.content.slice(0, 60) : "",
      description: `#${index + 1}`,
    })
  })
  return out
}

/**
 * Creates a child from `parent`'s history up to (but excluding) `cut`, then
 * persists it. Mirrors `/fork`: the selected session is the parent, and only
 * the messages before the chosen cut point are copied.
 */
export async function forkSession(agent: MiniCode, parent: Session, cut: number): Promise<Session> {
  const forked = agent.createSession(parent.cwd)
  forked.parentSessionId = parent.id
  await forked.replaceMessages(
    parent.messages.slice(0, cut).map(message => ({ role: message.role, content: message.content })) as ModelMessage[],
  )
  return forked
}

/**
 * Creates a child copying `source`'s full history, then persists it. Mirrors
 * `/clone`.
 */
export async function cloneSession(agent: MiniCode, source: Session): Promise<Session> {
  const clone = agent.createSession(source.cwd)
  clone.parentSessionId = source.id
  await clone.replaceMessages(
    source.messages.map(message => ({ role: message.role, content: message.content })) as ModelMessage[],
  )
  return clone
}
