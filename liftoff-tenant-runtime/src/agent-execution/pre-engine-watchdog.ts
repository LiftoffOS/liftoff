// A deadline on the part of a run before its engine starts.
//
// Everything a run does before the engine takes over (admission, the canonical
// pause check, memory retrieval, model resolution, catalog and prompt building,
// the grounding read) is setup: seconds, normally. When one of those awaits
// hung on a dead connection the run sat there silently: no engine, no error,
// the person watching an empty turn, and nothing closing it for thirty minutes
// (the stalled-run reconciler). Each outbound call has its own deadline now;
// this is the backstop for the ones nobody has found yet.
//
// It covers SETUP ONLY. It disarms the moment the engine is about to start (or
// a workflow graph is about to run) and never bounds the run itself, so a long
// autonomous run is never cut by it. Nothing here caps a whole run.
//
// Mechanics: `guard()` races one setup await against the deadline, so a hang
// turns into a PreEngineDeadlineError thrown from that await and the run's own
// error handling (invocation closed as failed, agent lock released) runs as it
// does for any other failure. The hung call is abandoned, not cancelled; its
// own deadline ends it. `engineStarting()` disarms, and refuses to start an
// engine for a run the watchdog already failed, which can happen when an
// abandoned setup await resolves later.

export const PRE_ENGINE_DEADLINE_MS_DEFAULT = 120_000;

/** Env-overridable, for an operator who needs room while a slow dependency is
 *  investigated. 0 or garbage keeps the default. */
export function preEngineDeadlineMs(): number {
  const n = Number.parseInt(process.env.PRE_ENGINE_DEADLINE_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : PRE_ENGINE_DEADLINE_MS_DEFAULT;
}

export class PreEngineDeadlineError extends Error {
  override readonly name = 'PreEngineDeadlineError';
  readonly code = 'pre_engine_deadline_exceeded';
  constructor(
    readonly deadlineMs: number,
    /** The setup step that was waiting when the deadline passed. */
    readonly phase: string,
  ) {
    // "timed out" on purpose: classifyFailure reads it as 'timeout', which is
    // what this is, rather than as an engine fault or 'unknown'.
    super(`Run setup timed out after ${Math.round(deadlineMs / 1000)}s before the engine started (waiting on: ${phase})`);
  }
}

export class PreEngineWatchdog {
  private timer: NodeJS.Timeout | undefined;
  private phase = 'setup';
  private error: PreEngineDeadlineError | null = null;
  private disarmed = false;
  private readonly tripListeners = new Set<(_err: PreEngineDeadlineError) => void>();

  constructor(readonly deadlineMs: number = preEngineDeadlineMs()) {
    this.timer = setTimeout(() => this.trip(), deadlineMs);
    this.timer.unref?.();
  }

  /** True once the deadline passed before the engine started. */
  get tripped(): boolean {
    return this.error !== null;
  }

  /**
   * Await one setup step under the deadline. Rejects with PreEngineDeadlineError
   * when the deadline passes first (or has already passed). Once the watchdog is
   * disarmed this is a plain await.
   */
  guard<T>(work: Promise<T>, phase: string): Promise<T> {
    if (this.disarmed) return work;
    this.phase = phase;
    if (this.error) {
      work.catch(() => undefined);
      return Promise.reject(this.error);
    }
    return new Promise<T>((resolve, reject) => {
      const onTrip = (err: PreEngineDeadlineError) => reject(err);
      this.tripListeners.add(onTrip);
      work.then(
        (v) => { this.tripListeners.delete(onTrip); resolve(v); },
        (e) => { this.tripListeners.delete(onTrip); reject(e); },
      );
    });
  }

  /**
   * The engine (or the workflow graph) is about to start: stop the clock.
   * Idempotent. Throws when the watchdog has already failed this run, so an
   * abandoned setup that resumes late can never start an engine for it.
   */
  engineStarting(): void {
    if (this.error) throw this.error;
    this.dispose();
  }

  /** Stop the clock without starting anything (the run ended during setup). */
  dispose(): void {
    this.disarmed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.tripListeners.clear();
  }

  private trip(): void {
    if (this.disarmed || this.error) return;
    this.error = new PreEngineDeadlineError(this.deadlineMs, this.phase);
    for (const listener of this.tripListeners) listener(this.error);
    this.tripListeners.clear();
    this.timer = undefined;
  }
}
