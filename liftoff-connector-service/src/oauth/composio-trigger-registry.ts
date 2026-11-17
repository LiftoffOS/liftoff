// Composio trigger registry — maps our connector type to the Composio
// trigger slug we register when arming "watch for new events" on a
// composio_managed connector.
//
// The slug + per-toolkit trigger config are determined empirically from
// Composio's /api/v3/triggers_types catalog. Each
// trigger Composio exposes is either type=poll (Composio polls the
// vendor every `interval` minutes, default 2, minimum 1) or type=webhook
// (vendor pushes to Composio, who forwards). Delivery to us is identical
// in both cases — Composio HTTP-POSTs the V3 webhook envelope to the
// project-level URL configured in their dashboard
// (<this deployment>/api/internal/composio-webhook).
//
// Adding a new connector type to this table is the entire integration
// work — the receive endpoint (platform-backend) and the dispatch
// fan-out (tenant-runtime) are already generic over slug. Tenant-runtime
// has a paired COMPOSIO_TRIGGER_DISPATCH map that translates the slug
// to (source, entityType) for routing to event-registered agents; the
// two tables must be kept in sync. See
// liftoff-tenant-runtime/src/scheduling/composio-trigger-registry.ts.
//
// The catalog is the single source of truth — a connector's
// `polling[].eventTrigger` in catalog/connectors.ts drives BOTH this map (below,
// via deriveTriggersFromCatalog) and tenant-runtime's dispatch (derived from the
// fetched catalog), so the two can no longer drift. Adding a new event connector
// is one catalog entry: put `eventTrigger: { slug, triggerConfig? }` on the
// polling entry whose entityType the event should route to. No edit here.
//
// triggerConfig note: for polling-type Composio triggers we pin interval=1 (the
// lowest supported) so user-perceived latency is at most ~1 minute; webhook-type
// triggers (Outlook/Slack/Calendar/Jira/Trello/Typeform/Mailchimp) carry no
// interval. Those values live on the catalog eventTrigger.triggerConfig.

import { CONNECTORS } from '../catalog/connectors.js';

export interface ComposioTriggerSpec {
  /** Composio trigger slug — what we pass as the 2nd arg to
   *  composio.triggers.create(userId, slug, body). */
  slug: string;
  /** Per-trigger config Composio merges with its defaults. */
  triggerConfig?: Record<string, unknown>;
}

/** Catalog-derived triggers: any connector whose catalog polling entry declares
 *  an `eventTrigger` contributes here — the single-source-of-truth path. When a
 *  connector has multiple polling entries, the one carrying `eventTrigger` wins
 *  (only one may declare it). */
function deriveTriggersFromCatalog(): Record<string, ComposioTriggerSpec> {
  const out: Record<string, ComposioTriggerSpec> = {};
  for (const [type, def] of Object.entries(CONNECTORS)) {
    for (const p of def.polling ?? []) {
      if (p.eventTrigger) out[type] = { slug: p.eventTrigger.slug, triggerConfig: p.eventTrigger.triggerConfig };
    }
  }
  return out;
}

/** connector_type → trigger spec, derived purely from the catalog. */
export const COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE: Record<string, ComposioTriggerSpec> =
  deriveTriggersFromCatalog();

/** Returns true when the given connector type has an event-trigger
 *  mapping registered. Used by the webhook arm endpoint to decide
 *  whether to call composio.triggers.create vs returning "not
 *  supported". */
export function isComposioTriggerSupported(connectorType: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    COMPOSIO_TRIGGER_BY_CONNECTOR_TYPE,
    connectorType,
  );
}
