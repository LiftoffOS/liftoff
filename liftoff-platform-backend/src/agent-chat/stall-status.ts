// "Still working" on Slack and Teams (C4).
//
// A turn that spends four minutes inside one tool emits no events, so the
// messaging surfaces show nothing at all. On the web that is fine — the UI has
// its own liveness — but in a Slack thread it reads as the team member having
// silently given up, and people ask again or give up themselves.
//
// This wraps the turn's event stream and, when it goes quiet for long enough,
// lets the caller say so once, naming whatever it is doing. Deliberately not a
// progress bar: two lines maximum, and only when there is genuine dead air.

export const STALL_NOTICE_AFTER_MS = 60_000;

/** Two is enough to say "still going" without turning into a heartbeat. */
export const MAX_STALL_NOTICES = 2;

export interface StallStatusOptions {
  /** Called on silence, with the last tool seen this turn (null if none yet). */
  onStall: (lastTool: string | null) => void;
  /** Overridable for tests. */
  thresholdMs?: number;
  maxNotices?: number;
}

/**
 * Pass an event stream through unchanged, calling `onStall` when nothing has
 * been emitted for `thresholdMs`.
 *
 * The timer is cleared in a `finally`, which covers the early `return`s both
 * workers take (interrupt delivered, stop acknowledged) as well as a throw —
 * otherwise a notice could fire into a thread whose turn had already ended.
 */
export async function* withStallStatus<T extends { type: string; tool?: string }>(
  events: AsyncIterable<T>,
  options: StallStatusOptions,
): AsyncGenerator<T, void, undefined> {
  const thresholdMs = options.thresholdMs ?? STALL_NOTICE_AFTER_MS;
  const maxNotices = options.maxNotices ?? MAX_STALL_NOTICES;

  let timer: NodeJS.Timeout | null = null;
  let noticesSent = 0;
  let lastTool: string | null = null;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = () => {
    clear();
    if (noticesSent >= maxNotices) return;
    timer = setTimeout(() => {
      noticesSent += 1;
      try {
        options.onStall(lastTool);
      } catch {
        // A status line is a courtesy; it must never break the turn it is
        // reporting on.
      }
      // Re-arm so a very long tool call gets the second notice too.
      arm();
    }, thresholdMs);
    // Never hold the process open for a status message.
    timer.unref?.();
  };

  try {
    arm();
    for await (const event of events) {
      if (event.type === 'tool_call' && typeof event.tool === 'string') {
        lastTool = event.tool;
      }
      clear();
      yield event;
      arm();
    }
  } finally {
    clear();
  }
}

/**
 * The line itself. Product voice: no contractions, and it never calls the team
 * member an agent.
 */
export function stallNoticeText(lastTool: string | null): string {
  return lastTool
    ? `\n_Still working on this — currently using ${lastTool}._`
    : '\n_Still working on this._';
}
