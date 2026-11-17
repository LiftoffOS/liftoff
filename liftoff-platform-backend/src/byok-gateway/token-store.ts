// Mint, verify and revoke the credentials an agent subprocess is given in place
// of the customer's provider key.
//
// The value handed out is `liftoff_byok_{tenantId}_{secret}` and only its
// SHA-256 is stored. Carrying the tenant id in the clear is deliberate: it lets
// verification run under withTenantScope rather than needing a BYPASSRLS
// pre-tenant-context read, and the process that holds the token already knows
// which tenant it belongs to, so it discloses nothing it did not have.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { withTenantScope } from '../infrastructure/database';
import type { AiProviderKeyVendor } from '../tenant-ai-provider-keys/types';

/**
 * A door the gateway serves, which is WIDER than an account a customer can hold
 * a key for.
 *
 * The two vocabularies were always separate — `AiProviderKeyVendor` names the
 * four accounts the keys card offers — and `openrouter` is the first value in
 * one and not the other. An OpenRouter invoice is Liftoff's, so no customer key
 * can ever fund it; the door exists for a MANAGED session, so the families
 * reached through it have somewhere for their usage to be read off the wire.
 */
export type GatewayVendor = AiProviderKeyVendor | 'openrouter';

/**
 * Whose key this session was opened to spend.
 *
 *   'byok'    — the customer's own, with the managed key as the mid-run fallback.
 *   'managed' — Liftoff's own from the start.
 *
 * A managed session is not a degraded one, and it is not about who pays —
 * Liftoff pays either way. It is the only way the gateway's usage capture reaches
 * the runs Liftoff funds, which is nearly all of them.
 *
 * Decided once, when the session opens, and carried on the token — rather than
 * re-derived per request, which would be a second place for the same question to
 * be answered differently.
 */
export type GatewayMode = 'byok' | 'managed';

const TOKEN_PREFIX = 'liftoff_byok_';

/** How long a minted token stays usable.
 *
 *  Sized to outlast a long agent run without becoming a standing credential. A
 *  run that outlives it re-mints; a leaked one stops working on its own even if
 *  nothing notices it leaked. */
export const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

export interface GatewaySession {
  tenantId: string;
  invocationId: string;
  vendor: GatewayVendor;
  agentId: string | null;
  purpose: string;
  mode: GatewayMode;
}

export interface MintedToken extends GatewaySession {
  /** The value to put in the subprocess's environment. Returned exactly once —
   *  nothing stores it and nothing can read it back. */
  token: string;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Pull the tenant id back out of a presented token, so verification knows
 *  which tenant scope to open. Null for anything that is not one of ours. */
export function tenantIdFromToken(token: string): string | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const rest = token.slice(TOKEN_PREFIX.length);
  const separator = rest.indexOf('_');
  if (separator <= 0) return null;
  const tenantId = rest.slice(0, separator);
  // A UUID and nothing else. Without this a crafted token could smuggle
  // arbitrary text into set_config and the scope would fail closed on a cast
  // error rather than on a check we control.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    return null;
  }
  return tenantId;
}

export async function mintGatewayToken(session: GatewaySession): Promise<MintedToken> {
  const token = `${TOKEN_PREFIX}${session.tenantId}_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await withTenantScope(session.tenantId, async (client) => {
    await client.query(
      `INSERT INTO byok_gateway_tokens
         (token_hash, tenant_id, invocation_id, vendor, agent_id, purpose, mode,
          issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)`,
      [
        hashToken(token),
        session.tenantId,
        session.invocationId,
        session.vendor,
        session.agentId,
        session.purpose,
        session.mode,
        expiresAt,
      ],
    );
  });

  return { ...session, token, expiresAt };
}

/**
 * Resolve a presented token to the run it was minted for.
 *
 * Null for anything that is not a live token of ours: wrong shape, unknown,
 * expired, or revoked. The caller answers 401 for all four without saying
 * which, because the difference is only useful to somebody guessing.
 */
export async function verifyGatewayToken(token: string): Promise<GatewaySession | null> {
  const tenantId = tenantIdFromToken(token);
  if (!tenantId) return null;

  const presented = hashToken(token);

  return withTenantScope(tenantId, async (client) => {
    const result = await client.query<{
      token_hash: string;
      tenant_id: string;
      invocation_id: string;
      vendor: string;
      agent_id: string | null;
      purpose: string;
      mode: string;
    }>(
      `SELECT token_hash, tenant_id, invocation_id, vendor, agent_id, purpose, mode
         FROM byok_gateway_tokens
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > NOW()`,
      [presented],
    );
    const row = result.rows[0];
    if (!row) return null;

    // The lookup already matched on the hash, so this comparison can only
    // succeed — it is here so the code path that decides "this token is valid"
    // is a constant-time comparison rather than a database equality whose
    // timing we do not control.
    const a = Buffer.from(row.token_hash, 'hex');
    const b = Buffer.from(presented, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    return {
      tenantId: row.tenant_id,
      invocationId: row.invocation_id,
      vendor: row.vendor as GatewayVendor,
      agentId: row.agent_id,
      purpose: row.purpose,
      // Anything but the one other value is read as 'byok', which is what a row
      // written before the column existed was by construction. Failing toward
      // 'byok' also fails toward looking for the customer's key first, so a
      // corrupt value costs a key lookup rather than spending Liftoff's key on a
      // session the customer was funding.
      mode: row.mode === 'managed' ? 'managed' : 'byok',
    };
  });
}

/**
 * Revoke every live token for one run.
 *
 * The property section 4 buys: what an agent can print out of its own
 * environment is a URL and something we can turn off with one statement, rather
 * than the customer's provider key.
 */
export async function revokeRunTokens(tenantId: string, invocationId: string): Promise<number> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE byok_gateway_tokens
          SET revoked_at = NOW()
        WHERE tenant_id = $1 AND invocation_id = $2 AND revoked_at IS NULL`,
      [tenantId, invocationId],
    );
    return result.rowCount ?? 0;
  });
}
