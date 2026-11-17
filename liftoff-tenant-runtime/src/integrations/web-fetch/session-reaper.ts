import { getPool } from '../../infrastructure/database';
import { logger } from '../../infrastructure/logging';
import { VendorNotConnected, VendorConnectorErrored } from './web-tool-secrets';
import { closeSession as closeVendorSession } from '../../browser-sessions/session-vendor-proxy';
import { closeSession as closeSessionRow, endTakeoverHoldForClose } from '../../browser-sessions/repository';
import { dropConnection } from '../../browser-sessions/cdp-page';
import type { AnchorClient } from './anchor-client';
import type { BrowserUseClient } from './browser-use-client';
import type { BrowserbaseClient } from './browserbase-client';


/** One expired session's row, as the teardown needs it. */
export interface ExpiredSessionRow {
  id: string;
  tenant_id: string;
  vendor: string;
  vendor_session_id: string;
}

/**
 * Close ONE session whose time is up: the takeover hold, the pooled
 * connection, the vendor, then the row.
 *
 * Shared by the sweep and by a spawn that found the scope's own session
 * expired. A scope holds exactly one OPEN row — `web_sessions_one_active_per_thread`
 * and `_per_invocation` are partial unique indexes on `closed_at IS NULL` —
 * so a spawn cannot simply leave a dead row for the sweep to find later: the
 * insert would collide with it. Closing it here also gives the vendor its
 * browser back minutes earlier than the sweep would.
 *
 * Answers what the row's `closed_reason` was set to, so a caller can count
 * the same two outcomes the sweep counts.
 */
export async function closeExpiredSession(
  row: ExpiredSessionRow,
): Promise<{ outcome: 'closed' | 'failed'; byokUnreachable: boolean }> {
  // A person may still hold the keyboard on an expired session. The hold
  // ends here, before the vendor stops the browser, so the capture owner's
  // disconnect is read as the close it is and not as a lost observation.
  // The row itself still closes after the vendor answers.
  await endTakeoverHoldForClose(row.id);
  // The pooled connection and the recorder on it go before the vendor is
  // told, so the disconnect is ours and not an observation lost.
  await dropConnection(row.vendor, row.vendor_session_id).catch(() => undefined);
  try {
    // Through the vendor proxy, which dispatches on the row's own vendor.
    //
    // This was an if/else naming vendors, and browser_use was missing from
    // it for a while — the expensive kind of missing, because Browser Use
    // charges the whole requested window UP FRONT and refunds only on stop,
    // and an open session also holds one of the plan's concurrency slots,
    // so an unreaped row kept both until the vendor's own timeout. A
    // hand-written vendor list goes stale the day a vendor is added; the
    // proxy cannot.
    await closeVendorSession(row.vendor, row.vendor_session_id, row.tenant_id);
    // 'idle_timeout' means BOTH things a reader needs: the session ended
    // because nobody was using it, AND closeVendorSession returned, which is
    // what settles its cost. A row left with a NULL reason could not say
    // either — and NULL was also what the janitor wrote when it took a row
    // and settled nothing, so the column could not tell a healthy close from
    // a lost one. That ambiguity is why unbilled sessions went unnoticed for
    // as long as they did.
    //
    // Through the repository's closeSession, the one writer of closed_at, so
    // an open takeover hold ends with its session in one transaction.
    await closeSessionRow(row.id, 'idle_timeout');
    return { outcome: 'closed', byokUnreachable: false };
  } catch (err) {
    // Always mark the row closed locally — leaving expired rows open would
    // keep the admission slot reserved forever, and would block the scope's
    // next session on the one-open-row index.
    //
    // 'failed', not 'idle_timeout': closeVendorSession threw, so the vendor
    // was never told to stop and the cost was never settled. The slot is
    // recovered and the money is not, and the column must say so.
    await closeSessionRow(row.id, 'failed');
    if (err instanceof VendorNotConnected || err instanceof VendorConnectorErrored) {
      logger.info({
        id: row.id, tenant_id: row.tenant_id, vendor: row.vendor,
        vendor_session_id: row.vendor_session_id,
        event: 'session_reaper_byok_unreachable',
      }, 'session reaper: BYOK connector unavailable; vendor session left to vendor TTL');
      return { outcome: 'failed', byokUnreachable: true };
    }
    logger.warn({
      id: row.id, vendor: row.vendor, error: (err as Error).message,
    }, 'session reaper teardown failed (marked closed)');
    return { outcome: 'failed', byokUnreachable: false };
  }
}

export class SessionReaper {
  constructor(
    private anchor: AnchorClient,
    private browserbase: BrowserbaseClient,
    private browserUse: BrowserUseClient,
  ) {}

  /**
   * Sweep expired web_sessions and request vendor-side teardown.
   *
   * Under the BYOK migration every Anchor / Browserbase teardown call needs
   * the tenant's connector credential. When the connector is gone (tenant
   * disconnected during the session's lifetime) or in error state we
   * cannot reach the vendor — but the DB row still needs to be closed so
   * the in-flight admission slot frees. We mark the row closed locally and
   * emit a distinct log event so operators can spot the "vendor session
   * leaked" pattern. The vendor's own idle TTL will eventually reap the
   * upstream session.
   *
   * The `byok_unreachable` counter is reported in the sweep result so the
   * Cloud Scheduler endpoint can include it in its response (and a log-based
   * metric tracks the trend).
   */
  async sweep(): Promise<{ closed: number; failed: number; byokUnreachable: number }> {
    const pool = getPool();
    const expired = await pool.query(
      `SELECT id, tenant_id, vendor, vendor_session_id FROM web_sessions
       WHERE expires_at < now() AND closed_at IS NULL
       LIMIT 200`,
    );
    let closed = 0, failed = 0, byokUnreachable = 0;
    for (const row of expired.rows) {
      const result = await closeExpiredSession(row as ExpiredSessionRow);
      if (result.outcome === 'closed') closed++;
      else if (result.byokUnreachable) byokUnreachable++;
      else failed++;
    }
    return { closed, failed, byokUnreachable };
  }
}
