// The provenance store is shared, or the check is absent under scale-out.
//
// The record of a read and the check on the write that follows it are separate
// HTTP requests to a service with up to ten instances, and nothing routes both
// to the same one. With a Map in each process, a read observed on A and a
// write judged on B found no entry, and the missing-entry branch says "not
// judged" — the check silently gone exactly when the service is busy. The
// reviewer reproduced it with two module instances; this is the same
// reproduction, inverted: two store instances over one table see each other.

import {
  MemoryProvenanceStore,
  PostgresProvenanceStore,
  MAX_IDS_PER_INVOCATION,
  type ScopedQuery,
  _setProvenanceStoreForTesting,
} from '../provenance-store';
import { checkWriteProvenance, recordProvenance, seedProvenanceFromContext } from '../record-provenance';

/** A table, in memory, shared by every store instance that is handed it —
 *  enough of Postgres for the property under test: the insert ignores a
 *  duplicate primary key, the select returns the invocation's rows, and every
 *  statement carries the tenant it ran under. */
function fakeTable(): { query: ScopedQuery; rows: Array<Record<string, unknown>>; tenantsSeen: Set<string> } {
  const rows: Array<Record<string, unknown>> = [];
  const tenantsSeen = new Set<string>();
  let clock = 0;
  const query: ScopedQuery = async (tenantId, text, params) => {
    tenantsSeen.add(tenantId);
    if (/^INSERT/i.test(text.trim())) {
      const [tenant, invocation, ...rest] = params as [string, string, ...unknown[]];
      for (let i = 0; i + 3 < rest.length; i += 4) {
        const [kind, entityType, value] = rest.slice(i, i + 3) as [string, string, string];
        const dup = rows.some((r) => r.invocation_id === invocation && r.kind === kind && r.entity_type === entityType && r.value === value);
        if (!dup) rows.push({ tenant_id: tenant, invocation_id: invocation, kind, entity_type: entityType, value, created_at: clock++ });
      }
      return { rows: [] };
    }
    if (/SELECT kind, entity_type, value, created_at/.test(text)) {
      const invocation = params[0];
      const mine = rows.filter((r) => r.invocation_id === invocation && r.tenant_id === tenantId);
      return { rows: mine.sort((a, b) => (a.created_at as number) - (b.created_at as number)) };
    }
    return { rows: [] };
  };
  return { query, rows, tenantsSeen };
}

const TENANT = '11111111-1111-1111-1111-111111111111';
const PR_READ = { entityType: 'pull_request', returnsIds: [{ entityType: 'pull_request', path: 'head.sha' }] };
const REVIEW = { idArgs: ['head_sha'], entityType: 'pull_request' };

describe('one table, many instances', () => {
  afterEach(() => _setProvenanceStoreForTesting(undefined));

  it('a read recorded on one instance grounds a write judged on another', async () => {
    const table = fakeTable();
    const a = new PostgresProvenanceStore(table.query);
    const b = new PostgresProvenanceStore(table.query);

    _setProvenanceStoreForTesting(a);
    await recordProvenance({
      tenantId: TENANT, invocationId: 'inv-x', declaration: PR_READ, payload: { pullNumber: 123 },
      result: { number: 123, head: { sha: 'abc123def4567890' } }, isWrite: false,
    });

    _setProvenanceStoreForTesting(b);
    const verdict = await checkWriteProvenance({
      tenantId: TENANT, invocationId: 'inv-x', declaration: REVIEW, payload: { head_sha: 'abc123def4567890' },
    });
    expect(verdict).toEqual({ provenanced: true, basis: 'declared_id_args', unseen: [] });
  });

  it('and a write to an id no instance recorded is still unseen', async () => {
    const table = fakeTable();
    _setProvenanceStoreForTesting(new PostgresProvenanceStore(table.query));
    await recordProvenance({
      tenantId: TENANT, invocationId: 'inv-y', declaration: PR_READ, payload: {},
      result: { head: { sha: '1111111111111111' } }, isWrite: false,
    });
    _setProvenanceStoreForTesting(new PostgresProvenanceStore(table.query));
    const verdict = await checkWriteProvenance({
      tenantId: TENANT, invocationId: 'inv-y', declaration: REVIEW, payload: { head_sha: 'never-read-2222' },
    });
    expect(verdict.provenanced).toBe(false);
    expect(verdict.unseen).toEqual(['never-read-2222']);
  });

  it('two instances recording the same fact at once do not lose each other\'s rows', async () => {
    const table = fakeTable();
    const a = new PostgresProvenanceStore(table.query);
    const b = new PostgresProvenanceStore(table.query);
    await Promise.all([
      a.append(TENANT, 'inv-z', [{ kind: 'untyped', value: 'one' }, { kind: 'untyped', value: 'shared' }]),
      b.append(TENANT, 'inv-z', [{ kind: 'untyped', value: 'two' }, { kind: 'untyped', value: 'shared' }]),
    ]);
    const entry = await a.load(TENANT, 'inv-z');
    expect([...entry!.seenUntyped].sort()).toEqual(['one', 'shared', 'two']);
    expect(table.rows.filter((r) => r.value === 'shared')).toHaveLength(1);
  });

  it('given text and the seeds cross the process boundary too', async () => {
    // The seeds run in the agent service; the check runs in the gateway. With
    // a Map in each, the trigger's own identifiers were seeded into a process
    // the judge never read.
    const table = fakeTable();
    _setProvenanceStoreForTesting(new PostgresProvenanceStore(table.query));
    await seedProvenanceFromContext({ tenantId: TENANT, invocationId: 'inv-s', texts: ['Please review pull request abc123def4567890 today'] });
    _setProvenanceStoreForTesting(new PostgresProvenanceStore(table.query));
    const verdict = await checkWriteProvenance({
      tenantId: TENANT, invocationId: 'inv-s', declaration: REVIEW, payload: { head_sha: 'abc123def4567890' },
    });
    expect(verdict.provenanced).toBe(true);
  });

  it('every statement runs under the tenant, and a record with no tenant is refused rather than stored unscoped', async () => {
    const table = fakeTable();
    const store = new PostgresProvenanceStore(table.query);
    expect(await store.append(undefined, 'inv-t', [{ kind: 'untyped', value: 'x' }])).toBe(false);
    expect(await store.append(TENANT, 'inv-t', [{ kind: 'untyped', value: 'x' }])).toBe(true);
    await store.load(TENANT, 'inv-t');
    expect([...table.tenantsSeen]).toEqual([TENANT]);
  });

  it('a store that cannot be reached says so, and the check is not judged rather than wrong', async () => {
    const broken: ScopedQuery = async () => { throw new Error('connection refused'); };
    const store = new PostgresProvenanceStore(broken);
    expect(await store.append(TENANT, 'inv-b', [{ kind: 'untyped', value: 'x' }])).toBe(false);
    expect(await store.load(TENANT, 'inv-b')).toBeUndefined();
  });

  it('caps what one run holds, the way the memory store does', async () => {
    const table = fakeTable();
    const store = new PostgresProvenanceStore(table.query);
    const rows = Array.from({ length: MAX_IDS_PER_INVOCATION + 50 }, (_, i) => ({ kind: 'untyped' as const, value: `id-${i}` }));
    await store.append(TENANT, 'inv-c', rows);
    const entry = await store.load(TENANT, 'inv-c');
    expect(entry!.seenUntyped.size).toBe(MAX_IDS_PER_INVOCATION);
    // The most recent, not the oldest: a run works forward.
    expect(entry!.seenUntyped.has(`id-${MAX_IDS_PER_INVOCATION + 49}`)).toBe(true);
    expect(entry!.seenUntyped.has('id-0')).toBe(false);
  });
});

describe('the memory store', () => {
  it('is what a process without PROVENANCE_STORE=postgres gets, and behaves as the Map did', async () => {
    const store = new MemoryProvenanceStore();
    await store.append(undefined, 'inv-m', [{ kind: 'id', entityType: 'pull_request', value: 'abc' }, { kind: 'given', value: 'the request' }]);
    const entry = await store.load(undefined, 'inv-m');
    expect(entry!.seen.has('pull_request:abc')).toBe(true);
    expect(entry!.seenUntyped.has('abc')).toBe(true);
    expect(entry!.givenText).toEqual(['the request']);
  });
});
