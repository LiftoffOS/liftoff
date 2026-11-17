// Warehouse query guardrails — TR sister-gate (implementation plan §2 / §3D
// dual-path). Post-C5, composio_managed connectors dispatch IN-PROCESS here in
// tenant-runtime (composio-dispatcher), NOT via connector-service's gRPC
// execute-dispatcher. So the read-only SQL gate that connector-service applies
// to native warehouse clients (clients/warehouse/query-guardrails.ts) must be
// mirrored here for the Composio warehouse path (Supabase run_query) — otherwise
// the gate would leak on this path.
//
// This is a deliberate cross-repo mirror of connector-service's module (same
// fail-closed parser + row-cap). A future shared package would DRY the two;
// until then they must stay in lockstep. Keyed off canonicalKey (`<toolkit>.
// <stableName>`) because the sqlGuard metadata does not cross the gRPC boundary
// into TR's tool schema.

import type { Parser as SqlParser } from 'node-sql-parser';

export type WarehouseDialect = 'postgresql' | 'snowflake' | 'bigquery' | 'hive';

// Lazy-load the SQL parser. node-sql-parser bundles multi-dialect grammars and
// is comparatively heavy; a top-level import loaded it into the tool-gateway's
// baseline memory on EVERY runtime, which tipped the 512 MiB canary runtime
// over its limit (OOM → agent request terminated). It is only needed when a
// warehouse SQL read function is actually dispatched (rare), so we require it on
// first use and cache the instance — keeping baseline footprint flat.
let _parser: SqlParser | null = null;
function getParser(): SqlParser {
  if (!_parser) {
    const { Parser } = require('node-sql-parser') as typeof import('node-sql-parser');
    _parser = new Parser();
  }
  return _parser;
}

export const DEFAULT_MAX_ROWS = 1000;

/** canonicalKey → which arg holds the SQL + which dialect to parse it as. */
export const WAREHOUSE_SQL_GUARDS: Record<string, { sqlParam: string; dialect: WarehouseDialect }> = {
  // Supabase (Postgres) read query — the sole write-guard on this path (the
  // Composio Management-API PAT is admin; no DB-level backstop). Must stay in
  // lockstep with SQL_GUARD_OVERRIDES in connector-service.
  'supabase.run_query': { sqlParam: 'query', dialect: 'postgresql' },
};

export class ReadOnlyViolationError extends Error {
  constructor(public readonly reason: string, public readonly statement: string) {
    super(`read_only_violation: ${reason}`);
    this.name = 'ReadOnlyViolationError';
  }
}

interface SqlNode {
  type?: string;
  into?: { type?: string } | null;
  with?: Array<{ stmt?: { ast?: SqlNode } | SqlNode }> | null;
}


function assertSelectNode(node: SqlNode | undefined): void {
  if (!node || node.type !== 'select') {
    throw new ReadOnlyViolationError(
      `only a single read-only SELECT is permitted (got ${node?.type ?? 'unparseable'})`,
      '',
    );
  }
  if (node.into && node.into.type === 'into') {
    throw new ReadOnlyViolationError('SELECT ... INTO creates a table (write)', '');
  }
  if (Array.isArray(node.with)) {
    for (const cte of node.with) {
      const stmt = cte?.stmt as { ast?: SqlNode } | SqlNode | undefined;
      assertSelectNode((stmt as { ast?: SqlNode })?.ast ?? (stmt as SqlNode));
    }
  }
}

/** Throws unless `sql` is exactly ONE read-only SELECT. Fail-closed. */
export function assertReadOnly(sql: string, dialect: WarehouseDialect): void {
  let ast: unknown;
  try {
    ast = getParser().astify(sql, { database: dialect });
  } catch (e) {
    throw new ReadOnlyViolationError(
      `did not parse as a safe read (fail-closed): ${(e as Error).message.slice(0, 140)}`,
      sql,
    );
  }
  const stmts = (Array.isArray(ast) ? ast : [ast]) as SqlNode[];
  if (stmts.length !== 1) {
    throw new ReadOnlyViolationError(`multiple statements are not permitted (${stmts.length})`, sql);
  }
  try {
    assertSelectNode(stmts[0]);
  } catch (e) {
    if (e instanceof ReadOnlyViolationError) throw new ReadOnlyViolationError(e.reason, sql);
    throw e;
  }
}

/** Wrap a validated read-only query so at most `maxRows` rows return. */
export function enforceRowCap(sql: string, maxRows: number = DEFAULT_MAX_ROWS): string {
  const inner = sql.trim().replace(/;\s*$/, '');
  return `SELECT * FROM (\n${inner}\n) AS _lo_capped LIMIT ${maxRows}`;
}

/**
 * If `canonicalKey` names a warehouse read function, validate its SQL arg
 * read-only + row-cap it, returning a NEW args object with the capped SQL.
 * No-op (returns args unchanged) for every non-warehouse tool. Throws
 * {@link ReadOnlyViolationError} on any violation — fail-closed, the write
 * never dispatches.
 */
export function applyWarehouseGuard(
  canonicalKey: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const guard = WAREHOUSE_SQL_GUARDS[canonicalKey];
  if (!guard) return args;
  const sql = args[guard.sqlParam];
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new ReadOnlyViolationError(`missing SQL in arg '${guard.sqlParam}'`, String(sql));
  }
  assertReadOnly(sql, guard.dialect);
  return { ...args, [guard.sqlParam]: enforceRowCap(sql) };
}
