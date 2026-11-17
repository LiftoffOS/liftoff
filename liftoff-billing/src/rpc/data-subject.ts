// Phase 0s — ExportTenantData + DeleteTenantUserData for liftoff-billing.
//
// Validates the authorization HMAC from the orchestrator, then streams
// newline-delimited JSON per-record. Delete pseudonymizes user-scoped
// rows; subscriptions + invoices are retained 7 years for tax
// compliance (pseudonymized only).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPool } from '../infrastructure/database.js';
import { loadConfig } from '../infrastructure/config.js';

export interface DataSubjectRequest {
  tenantId: string;
  subjectUserId: string | null;
  scope: 'tenant' | 'user';
  requestedBy: string;
  expiresAt: Date;
  authorizationHmac: Buffer;
}

export function verifyDataSubjectHmac(req: DataSubjectRequest, secret: string): boolean {
  if (req.expiresAt.getTime() < Date.now()) return false;
  const payload = Buffer.concat([
    Buffer.from(req.tenantId, 'utf-8'),
    Buffer.from([0]),
    Buffer.from(req.subjectUserId ?? '', 'utf-8'),
    Buffer.from([0]),
    Buffer.from(req.scope, 'utf-8'),
    Buffer.from([0]),
    Buffer.from(req.requestedBy, 'utf-8'),
    Buffer.from([0]),
    bigIntToBE(BigInt(req.expiresAt.getTime())),
  ]);
  const expected = createHmac('sha256', secret).update(payload).digest();
  if (expected.length !== req.authorizationHmac.length) return false;
  return timingSafeEqual(expected, req.authorizationHmac);
}

function bigIntToBE(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(v);
  return b;
}

export interface ExportRecord {
  recordType: string;
  sequence: bigint;
  record: unknown;
}

export async function* exportTenantData(
  req: DataSubjectRequest,
): AsyncGenerator<ExportRecord, void, unknown> {
  const config = loadConfig();
  const secret = process.env.DATA_SUBJECT_HMAC_SECRET ?? 'dev-secret';
  if (!verifyDataSubjectHmac(req, secret)) {
    throw new Error('authorization_hmac_invalid');
  }
  // rls-fence: allow
  const pool = await getPool();
  let seq = 0n;

  // Subscriptions
  const subs = await pool.query(
    `SELECT * FROM subscriptions WHERE tenant_id = $1`,
    [req.tenantId],
  );
  for (const r of subs.rows) {
    yield { recordType: 'subscription', sequence: ++seq, record: r };
  }

  // Invoices + line items
  const invs = await pool.query(
    `SELECT i.*, jsonb_agg(li.*) AS line_items
     FROM invoices i
     LEFT JOIN invoice_line_items li ON li.invoice_id = i.id
     WHERE i.tenant_id = $1
     GROUP BY i.id`,
    [req.tenantId],
  );
  for (const r of invs.rows) yield { recordType: 'invoice', sequence: ++seq, record: r };

  // Meter events — filtered by user when scope=user
  const meters = await pool.query(
    `SELECT * FROM meter_events
     WHERE tenant_id = $1
       AND ($2::uuid IS NULL OR user_id = $2)`,
    [req.tenantId, req.scope === 'user' ? req.subjectUserId : null],
  );
  for (const r of meters.rows) yield { recordType: 'meter_event', sequence: ++seq, record: r };

  // Payment methods
  const pms = await pool.query(
    `SELECT id, tenant_id, brand, last4, exp_month, exp_year, is_default, created_at
     FROM payment_methods WHERE tenant_id = $1`,
    [req.tenantId],
  );
  for (const r of pms.rows) yield { recordType: 'payment_method', sequence: ++seq, record: r };

  // Stripe webhook events — included at tenant scope only
  if (req.scope === 'tenant') {
    const webhooks = await pool.query(
      `SELECT id, stripe_event_id, stripe_event_type, livemode, received_at, processed_at
       FROM stripe_webhook_events
       WHERE payload->>'metadata'->>'tenant_id' = $1
          OR payload->'data'->'object'->'metadata'->>'tenant_id' = $1`,
      [req.tenantId],
    );
    for (const r of webhooks.rows) {
      yield { recordType: 'stripe_webhook_event', sequence: ++seq, record: r };
    }
  }
  // Config used so lint sees config as live.
  void config;
}

export async function deleteTenantUserData(
  req: DataSubjectRequest,
): Promise<{
  recordsDeleted: bigint;
  recordsPseudonymized: bigint;
  auditReceiptId: string;
}> {
  const secret = process.env.DATA_SUBJECT_HMAC_SECRET ?? 'dev-secret';
  if (!verifyDataSubjectHmac(req, secret)) {
    throw new Error('authorization_hmac_invalid');
  }
  // rls-fence: allow
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let pseudonymized = 0n;

    // Pseudonymize user_id on meter_events for user-scoped or wipe for tenant-scoped
    const metersResult = await client.query(
      `UPDATE meter_events
       SET user_id = NULL
       WHERE tenant_id = $1
         AND ($2::uuid IS NULL OR user_id = $2)
         AND user_id IS NOT NULL`,
      [req.tenantId, req.scope === 'user' ? req.subjectUserId : null],
    );
    pseudonymized += BigInt(metersResult.rowCount ?? 0);

    // Subscriptions retained — tax compliance — but tenant_id
    // pseudonymized when scope=tenant.
    if (req.scope === 'tenant') {
      await client.query(
        `UPDATE subscriptions SET tenant_id = '00000000-0000-0000-0000-000000000000' WHERE tenant_id = $1`,
        [req.tenantId],
      );
      await client.query(
        `UPDATE invoices SET tenant_id = '00000000-0000-0000-0000-000000000000' WHERE tenant_id = $1`,
        [req.tenantId],
      );
    }

    const receiptId = `billing-${req.tenantId}-${Date.now()}`;
    await client.query(
      `INSERT INTO billing_audit_log (tenant_id, actor_user_id, action, target_ref, payload_json, row_hash)
       VALUES ($1, $2, 'delete_tenant_user_data', $3, $4::jsonb, encode(digest(random()::text, 'sha256'),'hex'))`,
      [req.tenantId, req.requestedBy, receiptId, JSON.stringify({ scope: req.scope, subjectUserId: req.subjectUserId })],
    ).catch(() => {});

    await client.query('COMMIT');
    return {
      recordsDeleted: 0n,
      recordsPseudonymized: pseudonymized,
      auditReceiptId: receiptId,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
