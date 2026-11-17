// Where a run's provenance lives: what its reads returned, what it was given.
//
// It lived in a Map in whichever process recorded it. That was one process
// when the gateway ran in-process with the engine; it is not any more. The
// gateway is its own service with up to ten instances, the record of a read
// and the check on the write that follows it are separate HTTP requests, and
// nothing routes both to the same instance. A read observed on instance A and
// a write judged on instance B found no entry, and the missing-entry branch
// says "not judged" — so under any scale-out the check was silently absent,
// and the shadow telemetry under-counted the exact runs it was for. And the
// seeds — the trigger's own payload, the run's context text — were written by
// the AGENT service into a Map the gateway never reads at all.
//
// So the store is a table, append-only. Every fact is one row keyed by the
// invocation; recording is an insert that ignores a duplicate, so two instances
// recording at once cannot lose each other's rows, and a check loads the rows
// and rebuilds the same three sets the Map held. The Map stays as the store for
// tests and for a process with no database, selected by `PROVENANCE_STORE`.
//
// Rows are scoped by tenant and the table is RLS-forced, so every statement
// runs inside `withTenantScope`; a caller without a tenant gets the memory
// store's answer, which is "nothing recorded", and a log line saying so.

import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

/** One fact about an invocation. `id` is a typed identifier a read returned
 *  or a write named; `untyped` a bare one; `given` a piece of text the run
 *  was legitimately handed. */
export interface ProvenanceRow {
  kind: 'id' | 'untyped' | 'given';
  entityType?: string;
  value: string;
}

/** The working shape the checks read — the three sets the Map always held. */
export interface InvocationProvenance {
  /** `${entityType}:${id}` for everything a read returned under a declared
   *  entity type, plus what earlier writes named. */
  seen: Set<string>;
  /** Bare ids, for the case where neither side declared an entity type. */
  seenUntyped: Set<string>;
  /** Text the run was legitimately GIVEN — the person's request, the agent's
   *  own instructions, the trigger — so an id that appears there is not "unseen". */
  givenText: string[];
  lastTouchedAt: number;
}

export interface ProvenanceStore {
  readonly kind: 'memory' | 'postgres';
  /** Add facts. Resolves TRUE when the store holds them. */
  append(tenantId: string | undefined, invocationId: string, rows: ProvenanceRow[]): Promise<boolean>;
  /** Everything recorded for the invocation, or undefined when nothing was. */
  load(tenantId: string | undefined, invocationId: string): Promise<InvocationProvenance | undefined>;
}

/** A run holds at most this many ids; oldest-first eviction. A run that reads
 *  a 10,000-row export should not pin 10,000 strings in memory for an hour.
 *  Applied by the memory store on write and by the table store on read (the
 *  most recent N rows), so the two answer alike. */
export const MAX_IDS_PER_INVOCATION = 500;
/** Cap on how much given text one run may hold, in characters. */
const MAX_GIVEN_CHARS = 200_000;
/** A run's entry lives this long past its last touch; a check on a run that
 *  ended an hour ago asks a question nobody needs answered. */
export const INVOCATION_TTL_MS = 30 * 60 * 1000;

// ── Memory ──────────────────────────────────────────────────────────────────

export class MemoryProvenanceStore implements ProvenanceStore {
  readonly kind = 'memory' as const;
  private readonly byInvocation = new Map<string, InvocationProvenance>();

  private sweep(now: number): void {
    for (const [id, entry] of this.byInvocation) {
      if (now - entry.lastTouchedAt > INVOCATION_TTL_MS) this.byInvocation.delete(id);
    }
  }

  private entryFor(invocationId: string): InvocationProvenance {
    const now = Date.now();
    this.sweep(now);
    const existing = this.byInvocation.get(invocationId);
    if (existing) { existing.lastTouchedAt = now; return existing; }
    const created: InvocationProvenance = { seen: new Set(), seenUntyped: new Set(), givenText: [], lastTouchedAt: now };
    this.byInvocation.set(invocationId, created);
    return created;
  }

  async append(_tenantId: string | undefined, invocationId: string, rows: ProvenanceRow[]): Promise<boolean> {
    const entry = this.entryFor(invocationId);
    for (const row of rows) applyRow(entry, row);
    return true;
  }

  async load(_tenantId: string | undefined, invocationId: string): Promise<InvocationProvenance | undefined> {
    const entry = this.byInvocation.get(invocationId);
    if (entry) entry.lastTouchedAt = Date.now();
    return entry;
  }

  /** Test seams. */
  _reset(): void { this.byInvocation.clear(); }
  _size(invocationId: string): number { return this.byInvocation.get(invocationId)?.seenUntyped.size ?? 0; }
}

/** The one rule both stores share: how a row lands in the sets, with the
 *  memory store's caps. */
function applyRow(entry: InvocationProvenance, row: ProvenanceRow): void {
  if (row.kind === 'given') {
    const held = entry.givenText.reduce((n, t) => n + t.length, 0);
    if (held + row.value.length <= MAX_GIVEN_CHARS) entry.givenText.push(row.value);
    return;
  }
  if (row.kind === 'id' && row.entityType) {
    if (entry.seen.size >= MAX_IDS_PER_INVOCATION) {
      const oldest = entry.seen.values().next();
      if (!oldest.done) entry.seen.delete(oldest.value);
    }
    entry.seen.add(`${row.entityType}:${row.value}`);
  }
  if (entry.seenUntyped.size >= MAX_IDS_PER_INVOCATION) {
    const oldest = entry.seenUntyped.values().next();
    if (!oldest.done) entry.seenUntyped.delete(oldest.value);
  }
  entry.seenUntyped.add(row.value);
}

// ── Postgres ────────────────────────────────────────────────────────────────

/** The query surface the table store needs — injectable so a test can stand
 *  in a shared fake and show two store instances reading each other's rows. */
export type ScopedQuery = (
  tenantId: string,
  text: string,
  params: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

const defaultScopedQuery: ScopedQuery = (tenantId, text, params) =>
  withTenantScope(tenantId, (client) => client.query(text, params), 'tool-gateway');

export class PostgresProvenanceStore implements ProvenanceStore {
  readonly kind = 'postgres' as const;
  private lastSweepAt = 0;
  constructor(private readonly query: ScopedQuery = defaultScopedQuery) {}

  async append(tenantId: string | undefined, invocationId: string, rows: ProvenanceRow[]): Promise<boolean> {
    if (rows.length === 0) return true;
    if (!tenantId) {
      logger.warn({ event: 'provenance_store_no_tenant', invocationId }, 'a provenance record with no tenant cannot be stored');
      return false;
    }
    // One statement, many rows; a duplicate fact is not an error. Insertion
    // order is what `load` reads back oldest-first, so `created_at` carries
    // a per-row offset to keep one batch ordered.
    const values: string[] = [];
    const params: unknown[] = [tenantId, invocationId];
    rows.forEach((row, i) => {
      params.push(row.kind, row.entityType ?? '', row.value, i);
      const b = 3 + i * 4;
      values.push(`($1, $2, $${b}, $${b + 1}, $${b + 2}, NOW() + ($${b + 3}::int * interval '1 microsecond'))`);
    });
    try {
      await this.query(
        tenantId,
        `INSERT INTO invocation_provenance (tenant_id, invocation_id, kind, entity_type, value, created_at)
         VALUES ${values.join(', ')}
         ON CONFLICT DO NOTHING`,
        params,
      );
      void this.sweepStale(tenantId);
      return true;
    } catch (err) {
      logger.warn({ err: (err as Error).message, event: 'provenance_store_append_failed', invocationId }, 'provenance rows not stored');
      return false;
    }
  }

  async load(tenantId: string | undefined, invocationId: string): Promise<InvocationProvenance | undefined> {
    if (!tenantId) return undefined;
    try {
      // The most recent ids, capped as the memory store caps on write; all of
      // the given text (capped in characters below), oldest first.
      const { rows } = await this.query(
        tenantId,
        `(SELECT kind, entity_type, value, created_at FROM invocation_provenance
            WHERE invocation_id = $1 AND kind IN ('id', 'untyped')
            ORDER BY created_at DESC LIMIT $2)
         UNION ALL
         (SELECT kind, entity_type, value, created_at FROM invocation_provenance
            WHERE invocation_id = $1 AND kind = 'given')
         ORDER BY created_at ASC`,
        [invocationId, MAX_IDS_PER_INVOCATION],
      );
      if (rows.length === 0) return undefined;
      const entry: InvocationProvenance = { seen: new Set(), seenUntyped: new Set(), givenText: [], lastTouchedAt: Date.now() };
      for (const r of rows) {
        applyRow(entry, {
          kind: r.kind as ProvenanceRow['kind'],
          ...(typeof r.entity_type === 'string' && r.entity_type.length > 0 ? { entityType: r.entity_type } : {}),
          value: String(r.value),
        });
      }
      return entry;
    } catch (err) {
      logger.warn({ err: (err as Error).message, event: 'provenance_store_load_failed', invocationId }, 'provenance rows not loaded; the write is not judged');
      return undefined;
    }
  }

  /** Rows outlive their run by the same TTL the Map used, swept at most once
   *  an hour per process, on the tenant's own rows. */
  private async sweepStale(tenantId: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < 60 * 60 * 1000) return;
    this.lastSweepAt = now;
    try {
      await this.query(tenantId, `DELETE FROM invocation_provenance WHERE created_at < NOW() - interval '1 day'`, []);
    } catch {
      // The next append tries again.
    }
  }
}

// ── Selection ───────────────────────────────────────────────────────────────

let current: ProvenanceStore | undefined;

/** The store this process records to and checks against. `PROVENANCE_STORE`
 *  names it: `postgres` in every deployment (set by the deploy step on both
 *  services), `memory` otherwise. */
export function getProvenanceStore(): ProvenanceStore {
  if (current) return current;
  current = process.env.PROVENANCE_STORE === 'postgres' ? new PostgresProvenanceStore() : new MemoryProvenanceStore();
  return current;
}

/** Test seam: swap the store, and reset it. */
export function _setProvenanceStoreForTesting(store: ProvenanceStore | undefined): void {
  current = store;
}
