// The coding tools connected to a workspace over MCP OAuth, for the teams
// page. ADR-032 keeps credential-management surfaces on static tokens
// (`listMcpTokens`); a person's connected tools are an identity surface and
// read the OAuth anchors instead: one active grant per (client, person,
// workspace), anchored on an mcp_tokens row that carries the account and the
// name the client registered under. The client row is joined for the live
// registered name, since a CIMD refresh can rename a client after consent.

import { withTenantScope } from '../infrastructure/database';
import { brandMcpClient } from './client-brand';
import type { McpClientSlug } from './client-brand';

export interface OauthConnectedTool {
  /** The anchor mcp_tokens.id: the identity every other surface keys on. */
  id: string;
  tenantId: string;
  accountId: string;
  /** The name the client registered under, verbatim. */
  clientName: string;
  clientSlug: McpClientSlug | null;
  clientLabel: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function listOauthConnectedTools(tenantId: string): Promise<OauthConnectedTool[]> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query(
      `SELECT t.id, t.tenant_id, t.account_id, c.client_name, t.last_used_at, t.created_at
       FROM mcp_tokens t
       JOIN oauth_grants g ON g.mcp_token_id = t.id AND g.tenant_id = t.tenant_id AND g.status = 'active'
       JOIN oauth_clients c ON c.client_id = g.client_id
       WHERE t.tenant_id = $1 AND t.auth_kind = 'oauth' AND t.status = 'active'
         AND t.deleted_at IS NULL AND t.expires_at > NOW()
       ORDER BY t.created_at DESC`,
      [tenantId],
    ),
  );
  return result.rows.map((r) => {
    const brand = brandMcpClient(r.client_name as string);
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      accountId: r.account_id as string,
      clientName: r.client_name as string,
      clientSlug: brand.slug,
      clientLabel: brand.label,
      lastUsedAt: r.last_used_at as string | null,
      createdAt: r.created_at as string,
    };
  });
}
