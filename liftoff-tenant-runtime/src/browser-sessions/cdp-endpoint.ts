// The CDP endpoint for a live session, and what each step of reaching it costs.
//
// Both CDP-driven vendors — Browser Use and Browserbase — recorded the endpoint
// on the session row when they created it, and then asked the vendor for it
// again on EVERY operation. That is a round trip across the internet to learn
// something already sitting in our own Postgres, repeated six ways per client
// (goto, active page, screenshot, content, extract, task) and twice over on the
// pane's page-state, which fetches a URL and a screenshot concurrently.
//
// Anchor is unaffected: it navigates over its own REST API and never speaks CDP.

import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

/** The endpoint we recorded when the session was created, or null.
 *
 *  Null is ordinary rather than exceptional: a session created before this
 *  column carried the URL, or a vendor that never reported one, simply falls
 *  back to asking. It is a local query on an indexed column, so the miss costs
 *  a millisecond and the hit saves a vendor round trip. */
export async function storedCdpUrl(vendorSessionId: string): Promise<string | null> {
  try {
    const { rows } = await getPool().query<{ cdp_url: string | null }>(
      `SELECT vendor_metadata->>'cdp_url' AS cdp_url
         FROM web_sessions
        WHERE vendor_session_id = $1 AND closed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [vendorSessionId],
    );
    const url = rows[0]?.cdp_url;
    return url && url.length > 0 ? url : null;
  } catch (err) {
    // Never fail an operation because the shortcut was unavailable. The caller
    // asks the vendor instead, which is exactly what it did before this existed.
    logger.warn(
      { err: (err as Error).message, vendor_session_id: vendorSessionId },
      'stored cdp_url lookup failed; falling back to the vendor',
    );
    return null;
  }
}

/** Where the time went inside one CDP operation.
 *
 *  Without it the only figure is the total — a slow goto with no way to tell a
 *  slow page from a slow connect, which is how you end up optimising
 *  whatever is easiest to reach rather than whatever is actually slow. */
export class PhaseTimer {
  private readonly start = Date.now();
  private last = this.start;
  private readonly phases: Record<string, number> = {};

  mark(phase: string): void {
    const now = Date.now();
    this.phases[`${phase}_ms`] = now - this.last;
    this.last = now;
  }

  /** One line per operation, with the phases beside the total so a regression
   *  in any single step is visible without re-deriving it from timestamps. */
  log(event: string, context: Record<string, unknown>): void {
    logger.info(
      { event, ...context, ...this.phases, total_ms: Date.now() - this.start },
      event,
    );
  }
}
