// Resolve a Stripe webhook delivery to the connector it belongs to.
//
// The endpoint URL carries the connector id (`/stripe/webhook/:connectorId`)
// because the delivery itself cannot identify us before its signature is
// verified, and the signature can only be verified with THAT connector's
// secret — a chicken and egg the URL breaks without trusting anything in the
// body.
//
// Stripe's own account id would not help here. Under DCR each tenant authorizes
// our client against their own Stripe account rather than becoming a connected
// account on a platform, so there is no `account` field to key on and no single
// platform-wide endpoint. One endpoint and one signing secret exist per
// connector.
//
// The id in the URL is not a secret and is not treated as one: it only selects
// which secret to verify against. A forged id resolves to a connector whose
// secret will not match the signature.
//
// Admin-scoped for the same reason as `findTenantsAwaitingInstall` for the
// GitHub App webhook: the request arrives from Stripe with no tenant context
// and no service token, so there is no tenant to scope to yet.

import { withAdminScope } from '../db/pool.js';

export interface StripeConnectorRef {
  tenantId: string;
  connectorId: string;
}

/** Find the tenant owning a Stripe connector, by the connector's own id. */
export async function findStripeConnectorById(
  connectorId: string,
): Promise<StripeConnectorRef | null> {
  const id = (connectorId ?? '').trim();
  // Guard before the query: the id lands in a parameterised placeholder, but a
  // malformed value would otherwise raise 22P02 (invalid uuid) and surface as a
  // 500 on a request the internet can make at will.
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;

  return withAdminScope(
    {
      caller: 'events/stripe-account-lookup.findStripeConnectorById',
      reason: 'Stripe webhook carries no tenant context',
    },
    async (client) => {
      const res = await client.query(
        `SELECT tenant_id, id FROM connectors WHERE id = $1 AND type = 'stripe'`,
        [id],
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0] as { tenant_id: string; id: string };
      return { tenantId: row.tenant_id, connectorId: row.id };
    },
  );
}
