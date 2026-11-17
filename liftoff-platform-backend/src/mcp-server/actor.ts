// The person behind an MCP call, resolved on EVERY call.
//
// mcpAuthMiddleware proves which token is calling and which account and tenant
// it was minted for. It never reads tenant_members: membership was checked once
// at consent, and a person removed from the workspace since then would keep
// every tool for as long as their token lived. resolveMcpActor re-reads the
// membership per call and fails closed — no membership, no actor, no tool.
// Membership is the ONLY closed door: the anchor row supplies the display
// name and the client's name, and a missing anchor (the token was verified,
// so this is a row deleted between two calls) falls back to the account.
//
// One tenant-scoped query per call: the membership, the account and the
// anchor row together. The chat worker, which holds only the anchor id, reads
// the anchor first (it needs the account before it can ask about membership)
// and passes what it read in.

import { withTenantScope } from '../infrastructure/database';
import { tenantMembersService } from '../tenant-members';
import type { TenantMemberRole } from '../tenant-members/types';
import type { McpAuthContext } from './types';

export interface McpActor {
  tenantId: string;
  accountId: string;
  keyId: string;
  keyType: McpAuthContext['keyType'];
  role: TenantMemberRole;
  displayName: string;
  /** The connected coding tool, by the name its mcp_tokens row carries (the
   *  OAuth client name for a grant anchor, the person's label for a static
   *  token). */
  client: string;
}

/** Who a token anchor stands for: the account it was minted for, a display
 *  name (first/last, email fallback), the connected client's name and the
 *  token kind auth would report for it. One query on the anchor row joined
 *  to accounts; mcp_tokens is RLS, so the read is tenant-scoped. */
export interface AnchorIdentity {
  accountId: string;
  displayName: string;
  client: string;
  keyType: McpAuthContext['keyType'];
}

/** The kind both auth paths assign an mcp_tokens anchor: mcp-auth.ts for a
 *  static token and oauth/verifier.ts for a grant both answer 'collab', an
 *  external caller. The worker's actor says what auth would have said. */
const ANCHOR_KEY_TYPE: McpAuthContext['keyType'] = 'collab';

function displayNameOf(row: { first_name: string | null; last_name: string | null; email: string }): string {
  const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return fullName || row.email;
}

export async function readAnchorIdentity(tenantId: string, keyId: string): Promise<AnchorIdentity | null> {
  const anchor = await withTenantScope(tenantId, (client) => client.query(
    `SELECT t.account_id, t.name, a.first_name, a.last_name, a.email
     FROM mcp_tokens t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = $1`,
    [keyId],
  ));
  const row = anchor.rows[0] as {
    account_id: string; name: string | null;
    first_name: string | null; last_name: string | null; email: string;
  } | undefined;
  if (!row) return null;
  return {
    accountId: row.account_id,
    displayName: displayNameOf(row),
    client: row.name ?? '',
    keyType: ANCHOR_KEY_TYPE,
  };
}

/** Resolve the actor for an authenticated call, or null when the account is
 *  not (or no longer) a member of the tenant the token was minted for. A
 *  caller that already read the anchor row (the chat worker) passes it in and
 *  only the membership is read. */
export async function resolveMcpActor(
  ctx: McpAuthContext,
  knownAnchor?: AnchorIdentity,
): Promise<McpActor | null> {
  if (knownAnchor) {
    const membership = await tenantMembersService.getMembership(ctx.tenantId, ctx.accountId);
    if (!membership) return null;
    return {
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      keyId: ctx.keyId,
      keyType: knownAnchor.keyType,
      role: membership.role,
      displayName: knownAnchor.displayName,
      client: knownAnchor.client,
    };
  }

  const result = await withTenantScope(ctx.tenantId, (client) => client.query(
    `SELECT m.role, a.first_name, a.last_name, a.email, t.name AS client
     FROM tenant_members m
     JOIN accounts a ON a.id = m.account_id
     LEFT JOIN mcp_tokens t ON t.id = $3
     WHERE m.tenant_id = $1 AND m.account_id = $2`,
    [ctx.tenantId, ctx.accountId, ctx.keyId],
  ));
  const row = result.rows[0] as {
    role: TenantMemberRole; first_name: string | null; last_name: string | null; email: string; client: string | null;
  } | undefined;
  if (!row) return null;
  return {
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    keyId: ctx.keyId,
    keyType: ctx.keyType,
    role: row.role,
    displayName: displayNameOf(row),
    client: row.client ?? '',
  };
}
