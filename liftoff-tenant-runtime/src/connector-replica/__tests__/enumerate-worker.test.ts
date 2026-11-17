// Enumeration worker, against a real database.
//
// The properties here are all about what happens when a pass is INCOMPLETE,
// because that is where a census quietly loses data: a cursor that advanced
// past a failed page, or a partial page that got read as "everything else is
// gone". Both failures produce a smaller census that looks perfectly healthy.
//
// Skipped unless TEST_DATABASE_URL is set (migration 370 applied).

import { Pool } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const TENANT = '00000000-0000-0000-0000-0000000ce101';
const CONNECTOR = '00000000-0000-0000-0000-0000000cc101';

let pool: Pool;

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: async (tenantId: string, fn: (c: unknown) => Promise<unknown>) => {
    const client = await (pool as Pool).connect();
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
      return await fn(client);
    } finally {
      client.release();
    }
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  EnumerationRateLimited,
  claimDueJobs,
  runEnumerationJob,
  type EnumerationBatch,
  type EnumerationJob,
} from '../enumerate-worker';

const entity = (id: string, type = 'channel') => ({
  remoteId: id,
  entityType: type,
  title: id,
  projectedPath: `slack/${type}s/${id}`,
});

async function scoped<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);
    return await fn(client);
  } finally {
    client.release();
  }
}

async function seedJob(scope = 'channels', cursor: string | null = null): Promise<EnumerationJob> {
  return scoped(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO connector_enumeration_state
         (tenant_id, connector_id, connector_type, scope, cursor, next_run_at)
       VALUES ($1,$2,'slack',$3,$4, NOW() - interval '1 minute')
       ON CONFLICT (tenant_id, connector_id, scope)
         DO UPDATE SET cursor = EXCLUDED.cursor, next_run_at = EXCLUDED.next_run_at
       RETURNING id`,
      [TENANT, CONNECTOR, scope, cursor],
    );
    return {
      id: rows[0].id as string,
      tenantId: TENANT,
      connectorId: CONNECTOR,
      connectorType: 'slack',
      scope,
      cursor,
    };
  });
}

async function liveEntities(): Promise<Array<{ remote_id: string; deleted: boolean }>> {
  return scoped(async (c) => {
    const { rows } = await c.query(
      `SELECT remote_id, deleted FROM connector_entities
        WHERE tenant_id = $1 AND connector_id = $2 ORDER BY remote_id`,
      [TENANT, CONNECTOR],
    );
    return rows;
  });
}

describeFn('enumerate-worker', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await scoped((c) =>
      c.query(`INSERT INTO tenants (id, external_id) VALUES ($1,'enum-test') ON CONFLICT DO NOTHING`, [TENANT]),
    ).catch(async () => {
      const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      await admin.query(`INSERT INTO tenants (id, external_id) VALUES ($1,'enum-test') ON CONFLICT DO NOTHING`, [TENANT]);
      await admin.end();
    });
  });

  beforeEach(async () => {
    await scoped(async (c) => {
      await c.query(`DELETE FROM connector_entities WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM connector_enumeration_state WHERE tenant_id = $1`, [TENANT]);
    });
  });

  afterAll(async () => {
    if (!pool) return;
    await scoped(async (c) => {
      await c.query(`DELETE FROM connector_entities WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM connector_enumeration_state WHERE tenant_id = $1`, [TENANT]);
    });
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]).catch(() => {});
    await pool.end();
  });

  it('writes the entities a page reports and advances the cursor', async () => {
    const job = await seedJob();
    const out = await runEnumerationJob({
      job,
      source: async () => ({ entities: [entity('C1'), entity('C2')], cursor: null, kind: 'complete' }),
    });

    expect(out.entitiesUpserted).toBe(2);
    expect(out.cursorAdvancedTo).toBeNull();
    expect((await liveEntities()).map((r) => r.remote_id)).toEqual(['C1', 'C2']);
  });

  it('is idempotent — re-running the same page does not duplicate', async () => {
    const job = await seedJob();
    const source = async (): Promise<EnumerationBatch> => ({
      entities: [entity('C1')], cursor: null, kind: 'complete',
    });
    await runEnumerationJob({ job, source });
    await runEnumerationJob({ job: await seedJob(), source });
    expect(await liveEntities()).toHaveLength(1);
  });

  it('follows the cursor across pages', async () => {
    const job = await seedJob();
    const pages: Record<string, EnumerationBatch> = {
      start: { entities: [entity('C1')], cursor: 'p2', kind: 'complete' },
      p2: { entities: [entity('C2')], cursor: null, kind: 'complete' },
    };
    const out = await runEnumerationJob({
      job,
      source: async ({ cursor }) => pages[cursor ?? 'start'],
    });
    expect(out.entitiesUpserted).toBe(2);
    expect((await liveEntities()).map((r) => r.remote_id)).toEqual(['C1', 'C2']);
  });

  it('marks an entity deleted only after a COMPLETE pass that reached the end', async () => {
    await runEnumerationJob({
      job: await seedJob(),
      source: async () => ({ entities: [entity('C1'), entity('C2')], cursor: null, kind: 'complete' }),
    });

    const out = await runEnumerationJob({
      job: await seedJob(),
      source: async () => ({ entities: [entity('C1')], cursor: null, kind: 'complete' }),
    });

    expect(out.entitiesMarkedDeleted).toBe(1);
    const rows = await liveEntities();
    expect(rows.find((r) => r.remote_id === 'C1')!.deleted).toBe(false);
    expect(rows.find((r) => r.remote_id === 'C2')!.deleted).toBe(true);
  });

  it('NEVER marks anything deleted from an incremental pass', async () => {
    // The failure this prevents: an incremental pass returns a window, so
    // everything outside it is absent by construction. Treating that as
    // deletion empties the census one page at a time.
    await runEnumerationJob({
      job: await seedJob(),
      source: async () => ({ entities: [entity('C1'), entity('C2')], cursor: null, kind: 'complete' }),
    });

    const out = await runEnumerationJob({
      job: await seedJob(),
      source: async () => ({ entities: [entity('C1')], cursor: null, kind: 'incremental' }),
    });

    expect(out.entitiesMarkedDeleted).toBe(0);
    expect((await liveEntities()).every((r) => r.deleted === false)).toBe(true);
  });

  it('does not mark deletions when the page bound truncated a complete pass', async () => {
    await runEnumerationJob({
      job: await seedJob(),
      source: async () => ({ entities: [entity('C1'), entity('C2')], cursor: null, kind: 'complete' }),
    });

    // Never returns a null cursor: the pass is complete in kind but was cut
    // short, so it has still only seen a window.
    const out = await runEnumerationJob({
      job: await seedJob(),
      source: async () => ({ entities: [entity('C1')], cursor: 'more', kind: 'complete' }),
      maxPages: 2,
    });

    expect(out.entitiesMarkedDeleted).toBe(0);
    expect((await liveEntities()).find((r) => r.remote_id === 'C2')!.deleted).toBe(false);
  });

  it('confines deletion to the entity types the pass covered', async () => {
    await runEnumerationJob({
      job: await seedJob('all'),
      source: async () => ({
        entities: [entity('C1', 'channel'), entity('F1', 'file')],
        cursor: null,
        kind: 'complete',
      }),
    });

    // A channels-only pass must not conclude the files are gone.
    const out = await runEnumerationJob({
      job: await seedJob('channels'),
      source: async () => ({ entities: [entity('C1', 'channel')], cursor: null, kind: 'complete' }),
    });

    expect(out.entitiesMarkedDeleted).toBe(0);
    expect((await liveEntities()).find((r) => r.remote_id === 'F1')!.deleted).toBe(false);
  });

  it('un-deletes an entity that comes back', async () => {
    await runEnumerationJob({
      job: await seedJob(),
      source: async () => ({ entities: [entity('C1')], cursor: null, kind: 'complete' }),
    });
    await runEnumerationJob({
      job: await seedJob(),
      source: async () => ({ entities: [], cursor: null, kind: 'complete' }),
    });
    await runEnumerationJob({
      job: await seedJob(),
      source: async () => ({ entities: [entity('C1')], cursor: null, kind: 'complete' }),
    });
    expect((await liveEntities()).find((r) => r.remote_id === 'C1')!.deleted).toBe(false);
  });

  it('parks the job on a vendor rate limit instead of sleeping a worker', async () => {
    const job = await seedJob();
    const out = await runEnumerationJob({
      job,
      source: async () => { throw new EnumerationRateLimited(60_000); },
    });

    expect(out.parkedForMs).toBeGreaterThanOrEqual(60_000);
    expect(out.error).toBeUndefined();

    const parked = await scoped(async (c) => {
      const { rows } = await c.query(
        `SELECT next_run_at > NOW() + interval '30 seconds' AS parked
           FROM connector_enumeration_state WHERE id = $1`,
        [job.id],
      );
      return rows[0].parked;
    });
    expect(parked).toBe(true);
  });

  it('keeps the pages it already reconciled when a later page fails', async () => {
    // The cursor is committed with its page, so the work already done survives
    // and the retry resumes from there rather than starting over or skipping.
    const job = await seedJob();
    let call = 0;
    const out = await runEnumerationJob({
      job,
      source: async () => {
        call++;
        if (call === 1) return { entities: [entity('C1')], cursor: 'p2', kind: 'complete' };
        throw new Error('vendor 500');
      },
    });

    expect(out.error).toMatch(/vendor 500/);
    expect((await liveEntities()).map((r) => r.remote_id)).toEqual(['C1']);

    const state = await scoped(async (c) => {
      const { rows } = await c.query(
        `SELECT cursor, consecutive_failures, last_error FROM connector_enumeration_state WHERE id = $1`,
        [job.id],
      );
      return rows[0];
    });
    expect(state.cursor).toBe('p2');
    expect(state.consecutive_failures).toBe(1);
    expect(state.last_error).toMatch(/vendor 500/);
  });

  it('does not mark deletions on a failed pass', async () => {
    await runEnumerationJob({
      job: await seedJob(),
      source: async () => ({ entities: [entity('C1'), entity('C2')], cursor: null, kind: 'complete' }),
    });
    const out = await runEnumerationJob({
      job: await seedJob(),
      source: async () => { throw new Error('vendor 500'); },
    });
    expect(out.entitiesMarkedDeleted).toBe(0);
    expect((await liveEntities()).every((r) => r.deleted === false)).toBe(true);
  });

  it('claims due jobs and pushes their next run out so a second worker takes different ones', async () => {
    await seedJob('channels');
    await seedJob('files');

    const first = await claimDueJobs(TENANT, 10);
    expect(first.map((j) => j.scope).sort()).toEqual(['channels', 'files']);

    // Already claimed: next_run_at has moved forward.
    const second = await claimDueJobs(TENANT, 10);
    expect(second).toEqual([]);
  });
});
