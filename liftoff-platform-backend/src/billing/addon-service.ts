// Add-on Service — Phase 4
//
// Manages the add-on catalog and per-account entitlement state.
//
// Activation flow (subscription-driven — primary path):
//   liftoff-billing receives customer.subscription.updated →
//   calls POST /api/internal/billing/subscription-items/sync →
//   syncSubscriptionItems() upserts subscription_items, then calls syncAddonEntitlements() →
//   syncAddonEntitlements() joins subscription_items against addon_catalog.stripe_price_id
//   and sets each entitlement TRUE/FALSE to match current Stripe subscription state.
//
// Activation flow (CS override — secondary path):
//   POST /api/internal/billing/entitlements/:accountId/activate { entitlementKey } →
//   activateAddon(accountId, addonKey) → setAddonEntitlement(accountId, key, true)
//
// entitlement_field safety: values come from addon_catalog.entitlement_field which is
// seeded at deploy time (not user-controlled). A runtime whitelist guards against any
// inadvertent value that could escape into a dynamic SQL column reference.
//
// entitlement_field safety: values come from addon_catalog.entitlement_field which is
// seeded at deploy time (not user-controlled). A runtime whitelist guards against any
// inadvertent value that could escape into a dynamic SQL column reference.

import { getPool, withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

// Whitelist of all boolean columns in the entitlements table that add-ons may toggle.
// If addon_catalog.entitlement_field is not in this set the update is refused and logged.
// Extend this set when adding new entitlement columns to the entitlements table.
const VALID_ENTITLEMENT_FIELDS: ReadonlySet<string> = new Set([
  'sso_enabled',
  'audit_log_export',
  'scim_enabled',
  'advanced_reporting',
  'priority_support_enabled',
  'advanced_analytics_enabled',
  'compliance_enabled',
  'advanced_security_enabled',
  'overage_protection_enabled',
  'custom_retention_enabled',
  'shared_collaboration_enabled',
  'human_experts_enabled',
  'dedicated_support_enabled',
  'scheduled_agents_enabled',
  'agent_delegation_enabled',
  'cross_agent_learning_enabled',
  'auto_reflection_enabled',
]);

export interface AddonCatalogEntry {
  id:                string;
  key:               string;
  name:              string;
  description:       string | null;
  priceCents:        number;
  billingPeriod:     'monthly' | 'one_time';
  stripePriceId:     string | null;
  entitlementField:  string;
  active:            boolean;
}

interface AddonRow {
  id:                string;
  key:               string;
  name:              string;
  description:       string | null;
  price_cents:       number;
  billing_period:    string;
  stripe_price_id:   string | null;
  entitlement_field: string;
  active:            boolean;
}

function mapAddon(row: AddonRow): AddonCatalogEntry {
  return {
    id:               row.id,
    key:              row.key,
    name:             row.name,
    description:      row.description,
    priceCents:       row.price_cents,
    billingPeriod:    row.billing_period as 'monthly' | 'one_time',
    stripePriceId:    row.stripe_price_id,
    entitlementField: row.entitlement_field,
    active:           row.active,
  };
}

// ── listAddons ─────────────────────────────────────────────────────────────────

export async function listAddons(): Promise<AddonCatalogEntry[]> {
  const pool = getPool();
  const result = await pool.query<AddonRow>(
    `SELECT id, key, name, description, price_cents, billing_period,
            stripe_price_id, entitlement_field, active
     FROM addon_catalog WHERE active = TRUE ORDER BY name`,
  );
  return result.rows.map(mapAddon);
}

// ── getAccountAddons ───────────────────────────────────────────────────────────
// Returns a map of addon key → whether it is active for the account.
// OR-aggregates across all tenants: active if any tenant row has the flag TRUE.
// (Handles new tenants provisioned after the last entitlement sync.)

export async function getAccountAddons(accountId: string): Promise<Record<string, boolean>> {
  const addons = await listAddons();
  if (addons.length === 0) return {};

  // entitlements is RLS + FORCE, and this deliberately spans every tenant under
  // one account, so there is no single tenant to scope to. Same shape and same
  // reason as setAddonEntitlement's read below. On the raw pool this threw
  // 42704 for every caller; r5/no-raw-pool-on-rls-table caught it.
  const entRows = await withAdminScope(
    { caller: 'billing.addon-service', reason: 'entitlements read across all tenants of an account (by account_id, no tenant filter)' },
    (client) => client.query<Record<string, unknown>>(
      `SELECT e.*
       FROM entitlements e
       JOIN tenants t ON t.id = e.tenant_id
       WHERE t.account_id = $1`,
      [accountId],
    ),
  );

  const result: Record<string, boolean> = {};
  for (const addon of addons) {
    result[addon.key] = entRows.rows.some(ent => !!ent[addon.entitlementField]);
  }
  return result;
}

// ── activateAddon / deactivateAddon ───────────────────────────────────────────

export async function activateAddon(accountId: string, addonKey: string): Promise<void> {
  await setAddonEntitlement(accountId, addonKey, true);
}

export async function deactivateAddon(accountId: string, addonKey: string): Promise<void> {
  await setAddonEntitlement(accountId, addonKey, false);
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function setAddonEntitlement(
  accountId: string,
  addonKey:  string,
  value:     boolean,
): Promise<void> {
  const pool = getPool();

  // Resolve the entitlement_field by addon key.
  // Also accept the entitlement_field name directly for backward compatibility
  // with any callers that pass the column name rather than the catalog key.
  const addonRow = await pool.query<{ entitlement_field: string }>(
    `SELECT entitlement_field FROM addon_catalog
     WHERE (key = $1 OR entitlement_field = $1) AND active = TRUE
     LIMIT 1`,
    [addonKey],
  );

  if (addonRow.rows.length === 0) {
    log.warn({ accountId, addonKey }, 'addon-service: unknown addon key');
    throw new Error(`Unknown addon key: ${addonKey}`);
  }

  const field = addonRow.rows[0].entitlement_field;

  if (!VALID_ENTITLEMENT_FIELDS.has(field)) {
    log.error(
      { accountId, addonKey, field },
      'addon-service: entitlement_field not in whitelist — refusing update to prevent SQL injection',
    );
    throw new Error(`Invalid entitlement field: ${field}`);
  }

  // Update all entitlement rows for tenants belonging to this account.
  // Accounts may have multiple tenants — all share the same add-on state.
  const updateResult = await withAdminScope({ caller: 'billing.addon-service', reason: 'entitlements read across all tenants of an account (by account_id, no tenant filter)' }, (client) => client.query(
    // Field name is validated against VALID_ENTITLEMENT_FIELDS above — safe to interpolate.
    `UPDATE entitlements e
     SET "${field}" = $2, updated_at = NOW()
     FROM tenants t
     WHERE t.id = e.tenant_id
       AND t.account_id = $1`,
    [accountId, value],
  ));

  if ((updateResult.rowCount ?? 0) === 0) {
    log.warn({ accountId, addonKey, field, value }, 'addon-service: entitlement update matched 0 rows — account has no entitlement rows yet');
  } else {
    log.info(
      { accountId, addonKey, field, value, rowsUpdated: updateResult.rowCount },
      'addon-service: entitlement updated',
    );
  }
}

// ── syncAddonEntitlements ──────────────────────────────────────────────────────
// Called at the end of syncSubscriptionItems (after subscription_items are upserted).
// Joins current subscription_items against addon_catalog.stripe_price_id to derive
// which add-ons the account currently has — then sets each entitlement accordingly.
// This is the primary activation path: no per-addon webhook calls needed from liftoff-billing.

export async function syncAddonEntitlements(accountId: string): Promise<void> {
  const pool = getPool();

  // Only process addons that have a Stripe price configured; un-priced addons
  // can never appear in subscription_items so there is nothing to sync.
  const catalogResult = await pool.query<{ key: string; stripe_price_id: string }>(
    `SELECT key, stripe_price_id
     FROM addon_catalog
     WHERE active = TRUE AND stripe_price_id IS NOT NULL`,
  );

  if (catalogResult.rows.length === 0) return;

  // Price IDs currently in the account's subscription (freshly upserted by syncSubscriptionItems).
  const itemsResult = await pool.query<{ stripe_price_id: string }>(
    `SELECT DISTINCT stripe_price_id
     FROM subscription_items
     WHERE account_id = $1 AND stripe_price_id IS NOT NULL`,
    [accountId],
  );
  const activePriceIds = new Set(itemsResult.rows.map(r => r.stripe_price_id));

  for (const addon of catalogResult.rows) {
    const isSubscribed = activePriceIds.has(addon.stripe_price_id);
    try {
      await setAddonEntitlement(accountId, addon.key, isSubscribed);
    } catch (err) {
      // Whitelist violation — catalog entry has a stripe_price_id but an invalid
      // entitlement_field. Log and continue rather than aborting the whole sync.
      log.error(
        { accountId, addonKey: addon.key, error: (err as Error).message },
        'addon-service: syncAddonEntitlements skipped addon due to error',
      );
    }
  }

  log.info({ accountId, addonCount: catalogResult.rows.length }, 'addon-service: addon entitlements synced from subscription');
}
