// Arming the Composio event trigger for a connection, wherever that connection
// came from.
//
// WHY THIS EXISTS
// ───────────────
// For a composio_managed connector, Composio's trigger system is the ONLY way
// events reach us: Google/Microsoft/Slack all reject our direct webhook arming
// because the OAuth client belongs to Composio, not to us. So a connector with
// no trigger instance is a connector that will never wake an agent — it can
// still execute tool calls perfectly, which is exactly why the gap is invisible.
//
// `composio.triggers.create` had ONE call site: the arm-watch endpoint in
// crud/router.ts, reached when a caller explicitly asks to arm a watch. Nothing
// armed a trigger when a connection COMPLETED. A reconnect mints a brand new
// connectedAccountId, and a trigger is bound to the account it was created
// against — so after any reconnect the connector goes ACTIVE, the Connections
// page shows it healthy, tool calls work, and no event is ever delivered again.
// Wired at one end.
//
// The fix belongs at the completion funnel rather than at the reconnect path,
// because both routes end there: `completeComposioConnection` is called by the
// OAuth callback (first connect) and by the stranded-connection reconciler
// (recovery). Arming once at the funnel covers every way a connection can come
// into existence, including ones added later.
//
// NOT FATAL BY DESIGN. A connection that completed is a connection the user
// finished; failing it because the trigger call errored would throw away a
// working credential and send them round the consent screen again for a
// condition they cannot influence. The arm is attempted, its outcome is logged
// as a distinct event, and the connection stands either way. A connector that
// is ACTIVE but unarmed is a real gap — but it is a smaller one than a
// connector that does not exist, and `composio_trigger_arm_failed` is the
// signal to act on.

import { logger } from '../infra/logging.js';
import { createComposioTriggerInstance } from './composio-client.js';
import { COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE } from './composio-trigger-registry.js';

export type TriggerArmOutcome =
  /** A trigger instance exists for this (connectedAccountId, slug). */
  | { kind: 'armed'; triggerId: string }
  /** This connector type has no event trigger registered — tool calls only. */
  | { kind: 'no_trigger_for_type' }
  /** The call failed. The connection is still good; events are not flowing. */
  | { kind: 'failed'; error: string };

/**
 * Ensure this connected account has its event trigger registered.
 *
 * Idempotent: `composio.triggers.create` upserts on
 * (connectedAccountId, slug), so calling it for a connection that is already
 * armed returns the existing trigger rather than creating a duplicate. That is
 * what makes it safe to call on EVERY completion instead of trying to detect
 * "is this a reconnect?" — a detection that would itself be a thing to get
 * wrong.
 */
export async function ensureComposioTriggerArmed(args: {
  tenantId: string;
  connectorId: string;
  connectorType: string;
  connectedAccountId: string;
}): Promise<TriggerArmOutcome> {
  const { tenantId, connectorId, connectorType, connectedAccountId } = args;

  const spec = COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE[connectorType];
  if (!spec) {
    // Not a defect: plenty of connectors are tool-call-only and have no event
    // surface. Logged at debug so it does not read as a problem.
    logger.debug(
      { connectorId, connectorType, tenantId },
      'composio_trigger_arm_skipped_no_spec',
    );
    return { kind: 'no_trigger_for_type' };
  }

  try {
    const { triggerId } = await createComposioTriggerInstance({
      tenantId,
      slug: spec.slug,
      connectedAccountId,
      triggerConfig: spec.triggerConfig,
    });
    logger.info(
      { connectorId, connectorType, tenantId, connectedAccountId, triggerId, slug: spec.slug },
      'composio_trigger_armed',
    );
    return { kind: 'armed', triggerId };
  } catch (err) {
    // Deliberately not rethrown — see the header. This is the log to alert on:
    // the connector will look healthy everywhere else while delivering nothing.
    logger.error(
      {
        connectorId,
        connectorType,
        tenantId,
        connectedAccountId,
        slug: spec.slug,
        err: (err as Error).message,
      },
      'composio_trigger_arm_failed',
    );
    return { kind: 'failed', error: (err as Error).message };
  }
}
