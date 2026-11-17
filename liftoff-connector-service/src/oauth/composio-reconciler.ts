// Composio connect reconciler.
//
// Makes the browser redirect a latency optimisation instead of a correctness
// dependency.
//
// The failure this exists for: /start creates a connection at Composio and a
// `cmp_` oauth_state row; the user completes consent; Composio is supposed to
// send the browser to /callback, which is where the connector row gets
// written. If that redirect does not happen — Composio changing its fallback,
// the user closing the popup, a network
// blip on the way back — the connection is ACTIVE and BILLED at Composio and
// Liftoff has no record of it at all. Nothing retries, because nothing knows.
//
// There is no push signal available: Composio publishes exactly four webhook
// event types (`composio_connected_account_expired`, `composio_trigger_
// disabled`, `composio_trigger_message` v1/v2) and none of them fire when a
// connection becomes ACTIVE. So recovery is a pull, and this is it.
//
// Every cycle: take `cmp_` oauth_state rows older than the grace period, ask
// Composio what actually happened to each connection, and finish the job.
//   ACTIVE            → complete the bind (same function /callback uses)
//   FAILED/EXPIRED/…  → drop the state row; nothing to recover
//   INITIATED/…       → leave it; the user may still be mid-consent
//
// Deliberately does NOT delete connections at Composio. Reaping a live
// connection is irreversible and costs the user their consent; adopting it
// gives them a working connector instead. Rows that stay unresolved surface in
// the summary log rather than being cleaned up behind someone's back.

import { logger } from '../infra/logging.js';
import {
  listPendingComposioOAuthStates,
  deleteOAuthState,
  type OAuthStateRow,
} from './connector-ops.js';
import { getComposio, type ComposioConnectedAccount } from './composio-client.js';
import { completeComposioConnection } from './composio-bind.js';

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * How long a connect must sit unfinished before we touch it. Long enough that
 * a user still clicking through vendor consent is never raced by the
 * reconciler; short enough that a stranded connection is recovered while the
 * user is still around to notice it worked.
 */
const GRACE_PERIOD_SECONDS = 15 * 60; // 15 minutes

/** Cap per cycle so a backlog drains steadily instead of stalling the loop. */
const MAX_PER_CYCLE = 50;

/** Composio statuses that mean "this will never become ACTIVE". */
const TERMINAL_DEAD = new Set(['FAILED', 'EXPIRED', 'REVOKED', 'DELETED']);

export interface ReconcileSummary {
  examined: number;
  adopted: number;
  stillPending: number;
  dropped: number;
  errored: number;
}

/**
 * One reconciliation pass. Exported for tests and for a future admin-triggered
 * run; the scheduler below is the production caller.
 */
export async function runComposioReconcileCycle(): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    examined: 0,
    adopted: 0,
    stillPending: 0,
    dropped: 0,
    errored: 0,
  };

  let pending: OAuthStateRow[];
  try {
    pending = await listPendingComposioOAuthStates(GRACE_PERIOD_SECONDS, MAX_PER_CYCLE);
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'composio_reconcile_list_failed',
    );
    return summary;
  }
  if (pending.length === 0) return summary;

  summary.examined = pending.length;

  for (const oauthState of pending) {
    const extra = (oauthState.extra ?? {}) as {
      composioConnectedAccountId?: string;
      composioAuthConfigId?: string;
    };
    const connectedAccountId = extra.composioConnectedAccountId;
    const composioAuthConfigId = extra.composioAuthConfigId;

    // A cmp_ row without its payload can never be completed — the connection
    // id is the only handle we have on the Composio side.
    if (!connectedAccountId || !composioAuthConfigId) {
      await deleteOAuthState(oauthState.state);
      summary.dropped++;
      logger.warn(
        { state: oauthState.state, tenantId: oauthState.tenantId },
        'composio_reconcile_dropped_incomplete_state',
      );
      continue;
    }

    try {
      // Single read, not pollConnectedAccountActive: we are minutes past the
      // consent, so either it is done or it is not. Polling here would hold
      // the cycle open for 30s per row for no benefit.
      const account = (await getComposio().connectedAccounts.get(
        connectedAccountId,
      )) as unknown as ComposioConnectedAccount;

      if (account.status === 'ACTIVE') {
        const { connectorId } = await completeComposioConnection({
          state: oauthState.state,
          oauthState,
          connectedAccount: account,
          composioAuthConfigId,
          source: 'reconciler',
        });
        summary.adopted++;
        logger.info(
          {
            connectorId,
            connectedAccountId,
            connectorType: oauthState.connectorType,
            tenantId: oauthState.tenantId,
            strandedForMs: Date.now() - oauthState.createdAt.getTime(),
          },
          'composio_reconcile_adopted_stranded_connection',
        );
        continue;
      }

      if (TERMINAL_DEAD.has(account.status)) {
        await deleteOAuthState(oauthState.state);
        summary.dropped++;
        logger.info(
          {
            connectedAccountId,
            status: account.status,
            connectorType: oauthState.connectorType,
            tenantId: oauthState.tenantId,
          },
          'composio_reconcile_dropped_dead_connection',
        );
        continue;
      }

      // INITIATED / INITIALIZING — the user may still be in the vendor's
      // consent screen, or they abandoned it. Either way there is nothing to
      // bind yet, and the row costs one cheap read per cycle to keep.
      summary.stillPending++;
    } catch (err) {
      // Never let one bad row stop the cycle: the next row may be a
      // recoverable connection, and a Composio blip must not strand it too.
      summary.errored++;
      logger.error(
        {
          err: (err as Error).message,
          connectedAccountId,
          connectorType: oauthState.connectorType,
          tenantId: oauthState.tenantId,
        },
        'composio_reconcile_row_failed',
      );
    }
  }

  // Only speak up when something happened. A quiet reconciler is the normal
  // state and should not fill the log with zeros.
  if (summary.adopted > 0 || summary.dropped > 0 || summary.errored > 0) {
    logger.info({ ...summary }, 'composio_reconcile_cycle');
  }

  return summary;
}

/** Start the periodic reconciler. Mirrors startPollingScheduler's shape. */
export function startComposioReconciler(): NodeJS.Timeout {
  logger.info(
    { intervalMs: RECONCILE_INTERVAL_MS, graceSeconds: GRACE_PERIOD_SECONDS },
    'composio reconciler started',
  );
  return setInterval(() => void runComposioReconcileCycle(), RECONCILE_INTERVAL_MS);
}
