// Shared helper for resolving the default payment method on file for a tenant.
// Reads from the LOCAL payment_methods table, which is kept in sync by the
// payment_method.attached/updated webhooks via onPaymentMethodChanged. No
// Stripe API call needed.
//
// Used by:
//   • stripe-event-processor.ts (receipt + auto-reload-failed payloads)
//   • internal-admin-router.ts (auto-reload failure handler)

import type { Pool, PoolClient } from 'pg';

export interface DefaultPaymentMethod {
  type: 'card' | 'us_bank_account';
  last4: string;
}

export async function lookupDefaultPaymentMethod(
  db: Pool | PoolClient,
  tenantId: string,
): Promise<DefaultPaymentMethod | null> {
  const row = await db.query<{ brand: string; last4: string }>(
    `SELECT brand, last4 FROM payment_methods
       WHERE tenant_id = $1 AND is_default = TRUE
       ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  if (!row.rows[0]) return null;
  // Local payment_methods table currently only stores card details (no type column);
  // ACH support would require a schema extension. For now, default to 'card'.
  return { type: 'card', last4: row.rows[0].last4 };
}
