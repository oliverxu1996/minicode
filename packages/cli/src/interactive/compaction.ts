import type { CompactionOutcome, Session } from "@loongcode/agent"

/** The application's transient view of one manual compaction. */
export interface CompactionObserver {
  /** Called once, immediately before the compaction starts. */
  begin(): void
  /** Called exactly once when the compaction settles, however it settles. */
  end(): void
}

/** The compaction capability this helper drives (a `Compactor` satisfies it). */
export interface CompactionRunner {
  compact(session: Session): Promise<CompactionOutcome>
}

/**
 * Runs one manual compaction with an observer bracketing its lifetime.
 *
 * A manual `/compact` is an application-level operation with no runtime event,
 * so the application owns its transient "compacting" state. This helper is the
 * single place that brackets the awaited model call: `end` runs in `finally`,
 * so the state is cleared on success, on a reported failure, and on an
 * unexpected throw alike — there is no path that leaves the application
 * believing it is still compacting.
 */
export async function runCompaction(
  session: Session,
  runner: CompactionRunner,
  observer: CompactionObserver,
): Promise<CompactionOutcome> {
  // `begin` is inside the `try` too: even a failure while entering the state
  // must still run `end`, so the state can never be half-set and stranded.
  try {
    observer.begin()
    return await runner.compact(session)
  } finally {
    observer.end()
  }
}
