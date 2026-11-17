// The editable name and description of a coding-tool connection (migration
// 478). A connection is a developer-proxy credential or an mcp_tokens anchor;
// neither carries a name the person chose or a description, so what the teams
// page shows is derived (assembly.ts) unless a profile row says otherwise. A
// NULL column means "as derived".

import { withTenantScope } from '../infrastructure/database';

export interface ConnectionProfile {
  name: string | null;
  description: string | null;
}

export async function listConnectionProfiles(tenantId: string): Promise<Map<string, ConnectionProfile>> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query(
      `SELECT connection_id, name, description
       FROM coding_tool_connection_profiles
       WHERE tenant_id = $1`,
      [tenantId],
    ),
  );
  return new Map(result.rows.map((r) => [
    r.connection_id as string,
    { name: r.name as string | null, description: r.description as string | null },
  ]));
}

/** Write the profile for one connection. A field passed as undefined is left
 *  as it is; null clears it back to the derived value. */
export async function upsertConnectionProfile(opts: {
  tenantId: string;
  connectionId: string;
  updatedBy: string;
  name?: string | null;
  description?: string | null;
}): Promise<ConnectionProfile> {
  const result = await withTenantScope(opts.tenantId, (client) =>
    client.query(
      `INSERT INTO coding_tool_connection_profiles (connection_id, tenant_id, name, description, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (connection_id) DO UPDATE SET
         name        = CASE WHEN $6 THEN EXCLUDED.name        ELSE coding_tool_connection_profiles.name        END,
         description = CASE WHEN $7 THEN EXCLUDED.description ELSE coding_tool_connection_profiles.description END,
         updated_by  = EXCLUDED.updated_by,
         updated_at  = NOW()
       RETURNING name, description`,
      [
        opts.connectionId,
        opts.tenantId,
        opts.name ?? null,
        opts.description ?? null,
        opts.updatedBy,
        opts.name !== undefined,
        opts.description !== undefined,
      ],
    ),
  );
  const row = result.rows[0];
  return { name: row.name as string | null, description: row.description as string | null };
}
