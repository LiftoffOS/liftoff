// Making an observation outlive the process that made it.
//
// The gateway records the id-bearing PATHS of every read that passes it, which
// is the only way to learn `returnsIds` — nothing about a tool's arguments says
// what its response contains, so unlike `idArgs` it cannot be derived, only
// seen. Held only in memory they would be lost on every restart, so this store
// persists them.
//
// PATHS ONLY, never values. `items[].id` is a fact about a tool's shape; the
// ids themselves are customer data with no business outliving the request.

import { withTenantScope } from '../infrastructure/database';
import { catalogTypeFor } from '../connectors/tool-schema-cache';
import { logger } from '../infrastructure/logging';

export interface LearnedShape {
  connectorType: string;
  actionType: string;
  path: string;
  entityType: string | null;
  observedCount: number;
  /** The server the shape was observed on — `<type>-<8hex>` for a
   *  vendor-hosted or custom MCP server, '' for a catalog connector. */
  serverAlias: string;
}

/** An observation is keyed `<connectorType>.<action>` for a catalog connector
 *  and `<alias>.<remoteToolName>` for a vendor-hosted or custom server; the
 *  alias form carries an 8-hex instance suffix. Split into the columns. */
export function shapeKeyColumns(tool: string): { connectorType: string; actionType: string; serverAlias: string } | null {
  const sep = tool.indexOf('.');
  if (sep <= 0) return null;
  const head = tool.slice(0, sep);
  const actionType = tool.slice(sep + 1);
  const isAlias = /-[0-9a-f]{8}$/.test(head);
  return isAlias
    ? { connectorType: catalogTypeFor(head), actionType, serverAlias: head }
    : { connectorType: head, actionType, serverAlias: '' };
}

/** The cache key a stored row is read back under. */
export function shapeKeyOf(row: { connectorType: string; actionType: string; serverAlias: string }): string {
  return `${row.serverAlias || row.connectorType}.${row.actionType}`;
}

/**
 * Persist what this process has observed, as ACCEPTED declarations.
 *
 * They were written as pending proposals for a person to accept, and the
 * acceptance added nothing a person could judge: an observed path is a fact
 * about a response, and the one thing left to say about it — what the record
 * IS — the read tool's own catalog entry says already (`get_thread` returns a
 * `thread`). So the type rides in from the observer and the row lands
 * accepted; the gate reads it on the next refresh. Accepting can only ADD to
 * what a run has seen — a hold is for an id nothing read — so an observed path
 * that turns out to be noise costs nothing but a row.
 *
 * Upsert with a counter rather than insert-or-ignore: the counter still says
 * whether a path is a fluke or the tool's shape. A row a person REJECTED stays
 * rejected — re-observing it must not quietly resurrect it, which is the one
 * decision left to make and the reason the route to make it stays. A row
 * written pending before this change is promoted on its next observation.
 *
 * Best-effort: learning is not worth failing a tool call over.
 */
export async function persistObservedShapes(
  tenantId: string,
  /** tool -> path -> how many reads returned it since the last flush. */
  observed: Record<string, Record<string, number>>,
  /** tool -> the entity its read returns, where the catalog said. */
  entityTypes: Record<string, string> = {},
): Promise<number> {
  const rows: Array<[string, string, string, string, number, string | null]> = [];
  for (const [tool, paths] of Object.entries(observed)) {
    const cols = shapeKeyColumns(tool);
    if (!cols) continue;
    for (const [path, count] of Object.entries(paths)) {
      if (count > 0) rows.push([cols.connectorType, cols.actionType, cols.serverAlias, path, count, entityTypes[tool] ?? null]);
    }
  }
  if (rows.length === 0) return 0;

  try {
    // Under the tenant: the table is RLS-forced on `app.tenant_id`, and an
    // unscoped pool had every insert refused by the policy — this store never
    // held a row until this ran inside the scope.
    const written = await withTenantScope(tenantId, async (client) => {
      let n = 0;
      for (const [connectorType, actionType, serverAlias, path, count, entityType] of rows) {
        // The count is the number of reads this interval, added on: a path
        // seen once may be a fluke, a path seen a thousand times is the
        // tool's shape, and the column only says which if each read counts
        // once. The conflict target names the table's identity key, which
        // carries a `kind` column from a proposal kind that was removed
        // before it ever held a second value; every row is a response path.
        const res = await client.query(
          `INSERT INTO learned_response_shapes
             (tenant_id, connector_type, action_type, path, server_alias, kind, observed_count, entity_type, status, decided_by)
           VALUES ($1, $2, $3, $4, $5, 'returns_id', $6, $7, 'accepted', 'observer')
           ON CONFLICT (tenant_id, connector_type, action_type, path, server_alias, kind) DO UPDATE
             SET observed_count   = learned_response_shapes.observed_count + EXCLUDED.observed_count,
                 last_observed_at = NOW(),
                 entity_type      = COALESCE(learned_response_shapes.entity_type, EXCLUDED.entity_type),
                 status           = CASE WHEN learned_response_shapes.status = 'pending' THEN 'accepted'
                                         ELSE learned_response_shapes.status END,
                 decided_by       = CASE WHEN learned_response_shapes.status = 'pending' THEN 'observer'
                                         ELSE learned_response_shapes.decided_by END`,
          [tenantId, connectorType, actionType, path, serverAlias, count, entityType],
        );
        n += res.rowCount ?? 0;
      }
      return n;
    }, 'tool-gateway');
    return written;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, paths: rows.length },
      'learned_shapes_persist_failed',
    );
    return 0;
  }
}

/**
 * The paths a person has accepted, for the gate to read as `returnsIds`.
 *
 * Fails OPEN — an empty map, not a throw. A database hiccup must not strip a
 * tool of declarations it legitimately has: that would turn every judged write
 * on that connector into an unjudged one, which reads as coverage disappearing
 * rather than as an outage.
 */
export async function acceptedShapesFor(tenantId: string): Promise<Map<string, LearnedShape[]>> {
  // THROWS on a database error. It used to answer an empty map, which the
  // cache then kept as the truth for its whole TTL: a hiccup stripped every
  // tool of the declarations a person had accepted, and the cache's promise
  // to serve what it had was a promise it could not tell it had broken.
  // "Nothing accepted" and "could not ask" are different answers.
  const out = new Map<string, LearnedShape[]>();
  try {
    const res = await withTenantScope(tenantId, (client) => client.query<{
      connector_type: string;
      action_type: string;
      path: string;
      entity_type: string | null;
      observed_count: string;
      server_alias: string;
    }>(
      `SELECT connector_type, action_type, path, entity_type, observed_count, server_alias
         FROM learned_response_shapes
        WHERE tenant_id = $1 AND status = 'accepted'`,
      [tenantId],
    ), 'tool-gateway');
    for (const r of res.rows) {
      const row: LearnedShape = {
        connectorType: r.connector_type,
        actionType: r.action_type,
        path: r.path,
        entityType: r.entity_type,
        observedCount: Number(r.observed_count),
        serverAlias: r.server_alias ?? '',
      };
      const key = shapeKeyOf(row);
      const list = out.get(key) ?? [];
      list.push(row);
      out.set(key, list);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, tenantId }, 'learned_shapes_read_failed');
    throw err;
  }
  return out;
}

/** Proposals awaiting a decision, most-observed first. */
export async function pendingShapes(tenantId: string, limit = 200): Promise<LearnedShape[]> {
  const res = await withTenantScope(tenantId, (client) => client.query<{
    connector_type: string;
    action_type: string;
    path: string;
    entity_type: string | null;
    observed_count: string;
    server_alias: string;
  }>(
    `SELECT connector_type, action_type, path, entity_type, observed_count, server_alias
       FROM learned_response_shapes
      WHERE tenant_id = $1 AND status = 'pending'
      ORDER BY observed_count DESC, last_observed_at DESC
      LIMIT $2`,
    [tenantId, limit],
  ), 'tool-gateway');
  return res.rows.map((r) => ({
    connectorType: r.connector_type,
    actionType: r.action_type,
    path: r.path,
    entityType: r.entity_type,
    observedCount: Number(r.observed_count),
    serverAlias: r.server_alias ?? '',
  }));
}

/** Record a person's decision on one proposal. */
export async function decideShape(args: {
  tenantId: string;
  connectorType: string;
  actionType: string;
  path: string;
  status: 'accepted' | 'rejected';
  entityType?: string;
  decidedBy: string;
  /** '' (the default) for a catalog connector's shape. */
  serverAlias?: string;
}): Promise<boolean> {
  const res = await withTenantScope(args.tenantId, (client) => client.query(
    `UPDATE learned_response_shapes
        SET status = $5, entity_type = COALESCE($6, entity_type),
            decided_at = NOW(), decided_by = $7
      WHERE tenant_id = $1 AND connector_type = $2 AND action_type = $3 AND path = $4
        AND server_alias = $8`,
    [args.tenantId, args.connectorType, args.actionType, args.path,
     args.status, args.entityType ?? null, args.decidedBy, args.serverAlias ?? ''],
  ), 'tool-gateway');
  return (res.rowCount ?? 0) > 0;
}
