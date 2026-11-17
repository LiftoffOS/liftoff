// Warehouse query guardrails — the shared safety rails every data-warehouse
// client (Snowflake, Databricks, BigQuery, Supabase) runs before executing a
// query. See implementation plan §2.
//
// Enforces:
//   - read-only-by-statement-class, via a REAL SQL parser, fail-closed
//     (anything not provably a single SELECT is rejected);
//   - a hard row cap on returned rows;
// and carries the per-query audit record shape.

import { Parser } from 'node-sql-parser';

export type WarehouseDialect =
  | 'postgresql' // supabase
  | 'snowflake'
  | 'bigquery'
  | 'hive'; // databricks (Spark SQL ~ Hive dialect); approximate — see plan §13

export interface QueryGuardrails {
  /** Hard cap on rows returned to the agent. */
  maxRows: number;
  /** Client-side query timeout (ms). */
  timeoutMs: number;
  /** BigQuery cost ceiling (bytes billed); undefined where not applicable. */
  maxBytesBilled?: number;
}

export const DEFAULT_GUARDRAILS: QueryGuardrails = {
  maxRows: 1000,
  timeoutMs: 20_000,
};

/** Thrown when a statement is not a single read-only SELECT. */
export class ReadOnlyViolationError extends Error {
  constructor(
    public readonly reason: string,
    public readonly statement: string,
  ) {
    super(`Read-only violation: ${reason}`);
    this.name = 'ReadOnlyViolationError';
  }
}

// node-sql-parser AST nodes are loosely typed; model only what we inspect.
interface SqlNode {
  type?: string;
  into?: { type?: string } | null;
  with?: Array<{ stmt?: { ast?: SqlNode } | SqlNode }> | null;
}

const parser = new Parser();

function assertSelectNode(node: SqlNode | undefined): void {
  if (!node || node.type !== 'select') {
    throw new ReadOnlyViolationError(
      `only a single read-only SELECT is permitted (got ${node?.type ?? 'unparseable'})`,
      '',
    );
  }
  // `SELECT ... INTO <table>` materialises a table → a write.
  if (node.into && node.into.type === 'into') {
    throw new ReadOnlyViolationError('SELECT ... INTO creates a table (write)', '');
  }
  // Data-modifying CTEs (`WITH x AS (DELETE ...) ...`). Most dialects fail to
  // parse these here (→ fail-closed), but walk them for defense in depth.
  if (Array.isArray(node.with)) {
    for (const cte of node.with) {
      const stmt = cte?.stmt as { ast?: SqlNode } | SqlNode | undefined;
      assertSelectNode((stmt as { ast?: SqlNode })?.ast ?? (stmt as SqlNode));
    }
  }
}

/**
 * Throws {@link ReadOnlyViolationError} unless `sql` is exactly ONE read-only
 * SELECT. Fail-closed: anything the parser cannot parse as a safe read is
 * rejected.
 *
 * KNOWN LIMITATION (plan §13): a SELECT that calls a side-effecting/volatile
 * function still parses as a read and passes this gate. Where a scoped
 * read-only credential/role exists (native paths) the database is the backstop;
 * on the Supabase Composio path this gate is the sole write-guard, so this
 * limitation is documented and accepted.
 */
export function assertReadOnly(sql: string, dialect: WarehouseDialect): void {
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: dialect });
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
    if (e instanceof ReadOnlyViolationError) {
      throw new ReadOnlyViolationError(e.reason, sql);
    }
    throw e;
  }
}

/**
 * Wrap a validated read-only query so at most `maxRows` rows return. Uses an
 * outer subquery LIMIT — dialect-agnostic and never rewrites the inner query
 * (no risky AST round-trip). Call ONLY after {@link assertReadOnly}. Clients
 * should additionally pass a result cap to the vendor API where supported.
 */
export function enforceRowCap(sql: string, maxRows: number): string {
  const inner = sql.trim().replace(/;\s*$/, '');
  return `SELECT * FROM (\n${inner}\n) AS _lo_capped LIMIT ${maxRows}`;
}

/** Per-query audit record — logged via agent-audit-logs (plan §2). */
export interface QueryAuditRecord {
  connector: string;
  tenantId: string;
  statement: string;
  rowCount?: number;
  bytesScanned?: number;
  bytesBilled?: number;
  truncated?: boolean;
  ts: string;
}
