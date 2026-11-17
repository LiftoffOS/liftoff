// When the web-session reaper runs next.
//
// An open browser session costs money until it is closed: Browser Use charges
// the requested window up front and refunds on stop, and every open session
// holds one of the vendor plan's concurrency slots. The reaper used to run on
// an hourly clock. Each session stores its own expires_at, so the reaper is now
// armed for it: by the client that created the session (from the row its
// insert returned, so the create path makes no extra query), and after every
// sweep for the earliest one still open (which also covers a session whose
// lease keepSessionAliveFor moved out: the earlier task finds nothing due and
// re-arms for the new earliest).

import { getPool } from '../infrastructure/database';
import { armDue, MAINTENANCE_PATHS } from '../infrastructure/maintenance-tasks';
import { logger } from '../infrastructure/logging';

/** Arm the reaper for a session just created, from its inserted row. */
export function armWebSessionReapFor(row: { expires_at?: Date | string | null } | undefined): void {
  if (!row?.expires_at) return;
  armDue('web-sessions-reap', MAINTENANCE_PATHS.webSessionsReap, new Date(row.expires_at));
}

/** After a sweep: arm for the earliest session still open. */
export async function armNextWebSessionReap(): Promise<void> {
  try {
    const { rows } = await getPool().query<{ next: Date | null }>(
      `SELECT MIN(expires_at) AS next FROM web_sessions WHERE closed_at IS NULL AND expires_at IS NOT NULL`,
    );
    const next = rows[0]?.next;
    if (!next) return;
    armDue('web-sessions-reap', MAINTENANCE_PATHS.webSessionsReap, new Date(next));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Non-fatal: next web-session reap not armed');
  }
}
