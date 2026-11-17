// Event-source service layer.
//
// Wraps the SQL behind a small typed API so the management routes don't
// concatenate strings into the database directly. Every method takes
// tenantId and runs under withTenantScope (RLS enforced).
//
// All administrative actions emit audit rows via logAudit() (the same
// async-buffered pipeline used by 130+ call sites across the codebase).
// Rows land in `audit_log` and are picked up by the unified
// /api/audit/<tenantId>/events endpoint as well as the per-agent
// /api/internal-agents/:id/webhook/audit-log reader.

import { withTenantScope, withAdminScope } from '../infrastructure/database';
import { logAudit } from '../infrastructure/logging';
import { decryptSecret } from './secret-encryption';
import { log } from './log-scrubber';

export interface EventSource {
  id: string;
  tenantId: string;
  name: string;
  urlToken: string;
  hmacRequired: boolean;
  signingSecretHint: string;
  enabled: boolean;
  rateLimitPerMinute: number;
  maxPayloadBytes: number;
  contentFilterEnabled: boolean;
  piiHashMode: boolean;
  lastEventAt: string | null;
  lastResetAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EventSourceRow {
  id: string;
  tenant_id: string;
  name: string;
  url_token: string;
  hmac_required: boolean;
  signing_secret_hint: string;
  enabled: boolean;
  rate_limit_per_minute: number;
  max_payload_bytes: number;
  content_filter_enabled: boolean;
  pii_hash_mode: boolean;
  last_event_at: string | null;
  last_reset_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: EventSourceRow): EventSource {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    urlToken: r.url_token,
    hmacRequired: r.hmac_required,
    signingSecretHint: r.signing_secret_hint,
    enabled: r.enabled,
    rateLimitPerMinute: r.rate_limit_per_minute,
    maxPayloadBytes: r.max_payload_bytes,
    contentFilterEnabled: r.content_filter_enabled,
    piiHashMode: r.pii_hash_mode,
    lastEventAt: r.last_event_at,
    lastResetAt: r.last_reset_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SOURCE_SELECT_COLS = `id, tenant_id, name, url_token, hmac_required, signing_secret_hint,
        enabled, rate_limit_per_minute, max_payload_bytes,
        content_filter_enabled, pii_hash_mode,
        last_event_at, last_reset_at, created_at, updated_at`;

export async function getSourceForAgent(tenantId: string, agentId: string): Promise<EventSource | null> {
  return withTenantScope(tenantId, async (client) => {
    const r = await client.query<EventSourceRow>(
      `SELECT s.id, s.tenant_id, s.name, s.url_token, s.hmac_required,
              s.signing_secret_hint, s.enabled, s.rate_limit_per_minute,
              s.max_payload_bytes, s.content_filter_enabled, s.pii_hash_mode,
              s.last_event_at, s.last_reset_at, s.created_at, s.updated_at
       FROM event_sources s
       JOIN event_trigger_rules r ON r.source_id = s.id
       WHERE s.tenant_id = $1 AND r.tenant_id = $1 AND r.agent_id = $2
       LIMIT 1`,
      [tenantId, agentId],
    );
    return r.rows[0] ? mapRow(r.rows[0]) : null;
  });
}

export async function getSourceById(tenantId: string, sourceId: string): Promise<EventSource | null> {
  return withTenantScope(tenantId, async (client) => {
    const r = await client.query<EventSourceRow>(
      `SELECT ${SOURCE_SELECT_COLS}
       FROM event_sources WHERE id = $1 AND tenant_id = $2`,
      [sourceId, tenantId],
    );
    return r.rows[0] ? mapRow(r.rows[0]) : null;
  });
}

export async function deleteSource(input: {
  tenantId: string;
  sourceId: string;
  actorUserId: string;
}): Promise<boolean> {
  const result = await withTenantScope(input.tenantId, async (client) => {
    // Snapshot the row first so the audit row can carry a previousState diff.
    // CASCADE on event_trigger_rules + event_deliveries fires on DELETE.
    const beforeR = await client.query<EventSourceRow>(
      `SELECT ${SOURCE_SELECT_COLS}
       FROM event_sources WHERE id = $1 AND tenant_id = $2`,
      [input.sourceId, input.tenantId],
    );
    const before = beforeR.rows[0] ? mapRow(beforeR.rows[0]) : null;
    if (!before) return { deleted: false, before: null };

    const d = await client.query(
      `DELETE FROM event_sources WHERE id = $1 AND tenant_id = $2`,
      [input.sourceId, input.tenantId],
    );
    return { deleted: (d.rowCount ?? 0) > 0, before };
  });

  if (result.deleted && result.before) {
    logAudit('webhook.deleted', { tenantId: input.tenantId, userId: input.actorUserId }, {
      resourceType: 'event_source',
      resourceId: input.sourceId,
      previousState: {
        enabled: result.before.enabled,
        hmacRequired: result.before.hmacRequired,
        rateLimitPerMinute: result.before.rateLimitPerMinute,
        contentFilterEnabled: result.before.contentFilterEnabled,
        piiHashMode: result.before.piiHashMode,
      },
    });
  }
  return result.deleted;
}

export interface UpdateSourceInput {
  enabled?: boolean;
  hmacRequired?: boolean;
  rateLimitPerMinute?: number;
  contentFilterEnabled?: boolean;
  piiHashMode?: boolean;
}

// Fields we audit on settings_updated. `enabled` is broken out into its
// own webhook.enabled / webhook.disabled events.
const AUDITABLE_FIELDS = [
  'enabled',
  'hmacRequired',
  'rateLimitPerMinute',
  'contentFilterEnabled',
  'piiHashMode',
] as const;
type AuditableField = (typeof AUDITABLE_FIELDS)[number];

export async function updateSource(input: {
  tenantId: string;
  sourceId: string;
  patch: UpdateSourceInput;
  actorUserId: string;
}): Promise<EventSource | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (input.patch.enabled !== undefined) {
    sets.push(`enabled = $${i++}`);
    params.push(input.patch.enabled);
  }
  if (input.patch.hmacRequired !== undefined) {
    sets.push(`hmac_required = $${i++}`);
    params.push(input.patch.hmacRequired);
  }
  if (input.patch.rateLimitPerMinute !== undefined) {
    sets.push(`rate_limit_per_minute = $${i++}`);
    params.push(input.patch.rateLimitPerMinute);
  }
  if (input.patch.contentFilterEnabled !== undefined) {
    sets.push(`content_filter_enabled = $${i++}`);
    params.push(input.patch.contentFilterEnabled);
  }
  if (input.patch.piiHashMode !== undefined) {
    sets.push(`pii_hash_mode = $${i++}`);
    params.push(input.patch.piiHashMode);
  }
  if (sets.length === 0) {
    return getSourceById(input.tenantId, input.sourceId);
  }
  sets.push(`updated_at = NOW()`);
  params.push(input.sourceId, input.tenantId);

  // Fetch before-state and apply the UPDATE in the same tx. The audit emit
  // happens after the tx commits, so the row is captured iff the change
  // actually landed.
  const result = await withTenantScope(input.tenantId, async (client) => {
    const beforeR = await client.query<EventSourceRow>(
      `SELECT ${SOURCE_SELECT_COLS}
       FROM event_sources WHERE id = $1 AND tenant_id = $2`,
      [input.sourceId, input.tenantId],
    );
    const before = beforeR.rows[0] ? mapRow(beforeR.rows[0]) : null;
    if (!before) return { before: null, updated: null };

    const r = await client.query<EventSourceRow>(
      `UPDATE event_sources SET ${sets.join(', ')}
       WHERE id = $${i++} AND tenant_id = $${i}
       RETURNING ${SOURCE_SELECT_COLS}`,
      params,
    );
    const updated = r.rows[0] ? mapRow(r.rows[0]) : null;
    return { before, updated };
  });

  const { before, updated } = result;
  if (!updated || !before) return updated;

  // Compute which auditable fields actually changed (patch could include a
  // value equal to the current state; only emit an audit row on real diff).
  const changed = AUDITABLE_FIELDS.filter(
    (f) => input.patch[f] !== undefined && before[f] !== updated[f],
  );

  // Separate webhook.enabled / webhook.disabled from settings_updated because
  // enterprise reviewers filter on the enable/disable transition specifically.
  if (changed.includes('enabled')) {
    logAudit(updated.enabled ? 'webhook.enabled' : 'webhook.disabled',
      { tenantId: input.tenantId, userId: input.actorUserId }, {
        resourceType: 'event_source',
        resourceId: input.sourceId,
        previousState: { enabled: before.enabled },
        newState: { enabled: updated.enabled },
      });
  }

  const settingChanges = changed.filter((f): f is Exclude<AuditableField, 'enabled'> => f !== 'enabled');
  if (settingChanges.length > 0) {
    logAudit('webhook.settings_updated',
      { tenantId: input.tenantId, userId: input.actorUserId }, {
        resourceType: 'event_source',
        resourceId: input.sourceId,
        previousState: Object.fromEntries(settingChanges.map((f) => [f, before[f]])),
        newState: Object.fromEntries(settingChanges.map((f) => [f, updated[f]])),
      });
  }

  return updated;
}

export interface DeliverySummary {
  deliveryId: string;
  eventType: string | null;
  status: string;
  signatureValid: boolean;
  byteSize: number;
  receivedAt: string;
}

export async function listRecentDeliveries(
  tenantId: string,
  sourceId: string,
  limit = 5,
): Promise<DeliverySummary[]> {
  const clamped = Math.max(1, Math.min(50, limit));
  return withTenantScope(tenantId, async (client) => {
    // `received_at` is TIMESTAMPTZ — pg-types parses it as a JS Date at the
    // driver level, NOT a string. JSON.stringify on a Date calls its toJSON
    // and produces an ISO string, so the wire format is fine for browsers
    // that consume it directly. But express's res.json() is the only thing
    // making that conversion: any code path that does its own JSON
    // serialization (e.g. a future caching layer) would see the raw Date.
    // Explicit toISOString() removes the implicit dependency.
    const r = await client.query<{
      id: string;
      event_type: string | null;
      status: string;
      signature_valid: boolean;
      request_body_bytes: number;
      received_at: Date;
    }>(
      `SELECT id, event_type, status, signature_valid, request_body_bytes, received_at
       FROM event_deliveries
       WHERE source_id = $1 AND tenant_id = $2
       ORDER BY received_at DESC
       LIMIT $3`,
      [sourceId, tenantId, clamped],
    );
    return r.rows.map((row) => ({
      deliveryId: String(row.id),
      eventType: typeof row.event_type === 'string' ? row.event_type : null,
      status: String(row.status),
      signatureValid: Boolean(row.signature_valid),
      // request_body_bytes preserves the original payload size even when
      // pii_hash_mode is on and request_body is NULL.
      byteSize: typeof row.request_body_bytes === 'number'
        ? row.request_body_bytes
        : Number(row.request_body_bytes ?? 0),
      receivedAt: row.received_at instanceof Date
        ? row.received_at.toISOString()
        : String(row.received_at),
    }));
  });
}

// ── Admin-scope helpers (used by the public inbound router) ────────────────
//
// The inbound POST /api/events/custom/:token endpoint has no tenant context
// from the URL alone. We resolve `url_token → (source_id, tenant_id)` under
// withAdminScope, then switch into withTenantScope for everything else.

export interface InboundSourceLookup {
  sourceId: string;
  sourceName: string;
  tenantId: string;
  signingSecret: string;
  hmacRequired: boolean;
  rateLimitPerMinute: number;
  maxPayloadBytes: number;
  contentFilterEnabled: boolean;
  piiHashMode: boolean;
}

export async function adminLookupByToken(token: string): Promise<InboundSourceLookup | null> {
  const row = await withAdminScope(
    { caller: 'event-source-router', reason: 'inbound webhook tenant resolution' },
    async (client) => {
      const r = await client.query<{
        id: string;
        name: string;
        tenant_id: string;
        signing_secret_ciphertext: Buffer;
        hmac_required: boolean;
        rate_limit_per_minute: number;
        max_payload_bytes: number;
        content_filter_enabled: boolean;
        pii_hash_mode: boolean;
      }>(
        `SELECT id, name, tenant_id, signing_secret_ciphertext, hmac_required,
                rate_limit_per_minute, max_payload_bytes,
                content_filter_enabled, pii_hash_mode
         FROM event_sources
         WHERE url_token = $1 AND enabled = TRUE`,
        [token],
      );
      return r.rows[0] ?? null;
    },
  );
  if (!row) return null;
  let plaintext: string;
  try {
    plaintext = decryptSecret(row.signing_secret_ciphertext);
  } catch (err) {
    // Decryption failure is a data-integrity problem — log and fail closed
    // (treat as 404 to avoid leaking source existence to the caller).
    log.error(
      { sourceId: row.id, tenantId: row.tenant_id, error: (err as Error).message },
      'Failed to decrypt signing secret; treating source as missing',
    );
    return null;
  }
  return {
    sourceId: row.id,
    sourceName: row.name,
    tenantId: row.tenant_id,
    signingSecret: plaintext,
    hmacRequired: row.hmac_required,
    rateLimitPerMinute: row.rate_limit_per_minute,
    maxPayloadBytes: row.max_payload_bytes,
    contentFilterEnabled: row.content_filter_enabled,
    piiHashMode: row.pii_hash_mode,
  };
}

// ── Per-tenant cap CRUD (admin endpoint) ───────────────────────────────────

export interface TenantWebhookCaps {
  tenantId: string;
  maxRequestsPerMinute: number;
  dailyRunBudget: number | null;
}

export async function getTenantCaps(tenantId: string): Promise<TenantWebhookCaps | null> {
  return withTenantScope(tenantId, async (client) => {
    const r = await client.query<{
      tenant_id: string;
      max_requests_per_minute: number;
      daily_run_budget: number | null;
    }>(
      `SELECT tenant_id, max_requests_per_minute, daily_run_budget
       FROM tenant_webhook_caps WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      tenantId: row.tenant_id,
      maxRequestsPerMinute: row.max_requests_per_minute,
      dailyRunBudget: row.daily_run_budget,
    };
  });
}

export interface UpsertCapsInput {
  tenantId: string;
  maxRequestsPerMinute?: number;
  dailyRunBudget?: number | null;
  /** Required when the caller is a tenant admin acting on this tenant's caps. */
  actorUserId: string;
}

export async function upsertTenantCaps(input: UpsertCapsInput): Promise<TenantWebhookCaps> {
  const result = await withTenantScope(input.tenantId, async (client) => {
    // Capture before-state so the audit row carries the diff.
    const beforeR = await client.query<{
      tenant_id: string;
      max_requests_per_minute: number;
      daily_run_budget: number | null;
    }>(
      `SELECT tenant_id, max_requests_per_minute, daily_run_budget
       FROM tenant_webhook_caps WHERE tenant_id = $1`,
      [input.tenantId],
    );
    const before = beforeR.rows[0] ?? null;

    const r = await client.query<{
      tenant_id: string;
      max_requests_per_minute: number;
      daily_run_budget: number | null;
    }>(
      `INSERT INTO tenant_webhook_caps (tenant_id, max_requests_per_minute, daily_run_budget)
       VALUES ($1, COALESCE($2, 1000), $3)
       ON CONFLICT (tenant_id) DO UPDATE SET
         max_requests_per_minute = COALESCE($2, tenant_webhook_caps.max_requests_per_minute),
         daily_run_budget = $3,
         updated_at = NOW()
       RETURNING tenant_id, max_requests_per_minute, daily_run_budget`,
      [input.tenantId, input.maxRequestsPerMinute ?? null, input.dailyRunBudget ?? null],
    );
    const after = r.rows[0];
    return { before, after };
  });

  const after = result.after;
  const before = result.before;
  const changed =
    !before ||
    before.max_requests_per_minute !== after.max_requests_per_minute ||
    before.daily_run_budget !== after.daily_run_budget;

  if (changed) {
    logAudit('webhook.caps_updated', { tenantId: input.tenantId, userId: input.actorUserId }, {
      resourceType: 'event_source',
      resourceId: input.tenantId,
      previousState: before ? {
        maxRequestsPerMinute: before.max_requests_per_minute,
        dailyRunBudget: before.daily_run_budget,
      } : null,
      newState: {
        maxRequestsPerMinute: after.max_requests_per_minute,
        dailyRunBudget: after.daily_run_budget,
      },
    });
  }

  return {
    tenantId: after.tenant_id,
    maxRequestsPerMinute: after.max_requests_per_minute,
    dailyRunBudget: after.daily_run_budget,
  };
}

// ── DSAR purge (admin-scope) ───────────────────────────────────────────────

/**
 * Delete every event_deliveries row whose request_body_sha256 matches the
 * supplied digest. Used to satisfy right-to-erasure requests where a
 * customer can prove a specific payload contains their PII.
 *
 * Cross-tenant by design: a hash collision is astronomically unlikely, so we
 * accept the broad scope rather than forcing operators to know the tenant
 * upfront. The actor and reason are recorded in the admin-scope audit log.
 */
export async function purgeDeliveriesBySha256(input: {
  sha256: string;
  actorUserId: string;
  reason: string;
}): Promise<{ deletedCount: number }> {
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) {
    throw new Error('sha256 must be a 64-char hex string');
  }
  const result = await withAdminScope(
    {
      caller: 'event-sources.purgeDeliveriesBySha256',
      actor: input.actorUserId,
      reason: input.reason,
    },
    (client) => client.query(
      `DELETE FROM event_deliveries WHERE request_body_sha256 = $1`,
      [input.sha256.toLowerCase()],
    ),
  );
  return { deletedCount: result.rowCount ?? 0 };
}
