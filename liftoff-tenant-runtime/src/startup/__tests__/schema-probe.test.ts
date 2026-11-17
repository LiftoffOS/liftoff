// Asking whether this instance can actually serve, rather than whether it once
// could.
//
// The latched startup flag is right for a startup probe and wrong for a
// readiness one: an instance whose database has gone away, or whose schema was
// rolled back underneath it, keeps reporting ready and keeps accepting traffic
// it cannot serve. What matters in the tests below is that the probe is
// genuinely read-only, that it cannot become load of its own, and that it never
// leaves a connection behind.

import { EXPECTED_SCHEMA_VERSION, _resetSchemaReadyForTesting, probeSchema } from '../schema-check';

jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function fakePool(opts: {
  version?: number;
  failOn?: RegExp;
  connectThrows?: boolean;
} = {}) {
  const queries: string[] = [];
  const released: boolean[] = [];
  const pool = {
    connect: async () => {
      if (opts.connectThrows) throw new Error('no connection available');
      return {
        query: async (sql: string) => {
          queries.push(sql);
          if (opts.failOn?.test(sql)) throw new Error('probe query failed');
          if (/schema_version/.test(sql)) {
            return { rows: opts.version === undefined ? [] : [{ version: opts.version }] };
          }
          return { rows: [] };
        },
        release: () => released.push(true),
      };
    },
  };
  return { pool: pool as never, queries, released };
}

beforeEach(() => {
  _resetSchemaReadyForTesting();
  jest.useRealTimers();
});

describe('the probe', () => {
  it('reports ready when the schema is the one we expect', async () => {
    const { pool } = fakePool({ version: EXPECTED_SCHEMA_VERSION });
    const r = await probeSchema(pool);
    expect(r.dbReachable).toBe(true);
    expect(r.schemaCurrent).toBe(true);
  });

  it('reports not-current when the schema moved underneath us', async () => {
    // A rollback that leaves the instance running against a schema it was not
    // built for is exactly the case the latched flag cannot see.
    const { pool } = fakePool({ version: EXPECTED_SCHEMA_VERSION - 1 });
    const r = await probeSchema(pool);
    expect(r.dbReachable).toBe(true);
    expect(r.schemaCurrent).toBe(false);
  });

  it('reports not-current when there is no row at all', async () => {
    const { pool } = fakePool({});
    expect((await probeSchema(pool)).schemaCurrent).toBe(false);
  });

  it('is read-only, as a transaction', async () => {
    // Not a stylistic point: this runs on every health check from every
    // instance, and a probe that can write is a probe that can deadlock with
    // real work or leave a row behind.
    const { pool, queries } = fakePool({ version: EXPECTED_SCHEMA_VERSION });
    await probeSchema(pool);
    expect(queries.some((q) => /BEGIN READ ONLY/.test(q))).toBe(true);
    expect(queries.some((q) => /INSERT|UPDATE|DELETE/i.test(q))).toBe(false);
  });

  it('bounds the statement, so a struggling database cannot hold it open', async () => {
    const { pool, queries } = fakePool({ version: EXPECTED_SCHEMA_VERSION });
    await probeSchema(pool);
    expect(queries.some((q) => /SET LOCAL statement_timeout/.test(q))).toBe(true);
  });

  it('scopes the timeout to the transaction, not the connection', async () => {
    // `SET LOCAL` rather than `SET`: without LOCAL the timeout would leak onto
    // a pooled connection and later cancel somebody's real query.
    const { pool, queries } = fakePool({ version: EXPECTED_SCHEMA_VERSION });
    await probeSchema(pool);
    const stmt = queries.find((q) => /statement_timeout/.test(q))!;
    expect(stmt).toMatch(/SET LOCAL/);
  });
});

describe('when it goes wrong', () => {
  it('says unreachable rather than throwing', async () => {
    // A readiness endpoint that throws is a 500, and a 500 is indistinguishable
    // from the process being broken in some other way.
    const { pool } = fakePool({ failOn: /schema_version/ });
    const r = await probeSchema(pool);
    expect(r.dbReachable).toBe(false);
    expect(r.error).toContain('probe query failed');
  });

  it('carries the reason, so it is in the response and not only a log', async () => {
    const { pool } = fakePool({ failOn: /schema_version/ });
    expect((await probeSchema(pool)).error).toBeTruthy();
  });

  it('releases the connection even when the query failed', async () => {
    // Leaking one connection per failed probe drains the pool in minutes, and
    // the probe fires forever.
    const { pool, released } = fakePool({ failOn: /schema_version/ });
    await probeSchema(pool);
    expect(released).toHaveLength(1);
  });

  it('rolls back rather than leaving a transaction open', async () => {
    const { pool, queries } = fakePool({ failOn: /schema_version/ });
    await probeSchema(pool);
    expect(queries.some((q) => /ROLLBACK/.test(q))).toBe(true);
  });

  it('survives a pool that cannot hand out a connection', async () => {
    const { pool } = fakePool({ connectThrows: true });
    await expect(probeSchema(pool)).rejects.toThrow();
  });
});

describe('cost', () => {
  it('caches, so health-check traffic does not become database load', async () => {
    const { pool, queries } = fakePool({ version: EXPECTED_SCHEMA_VERSION });
    await probeSchema(pool);
    const afterFirst = queries.length;
    await probeSchema(pool);
    await probeSchema(pool);
    expect(queries.length).toBe(afterFirst);
  });

  it('collapses concurrent probes onto one query', async () => {
    // Cloud Run can deliver several health checks at once, and three identical
    // round trips answer nothing that one does.
    const { pool, queries } = fakePool({ version: EXPECTED_SCHEMA_VERSION });
    await Promise.all([probeSchema(pool), probeSchema(pool), probeSchema(pool)]);
    expect(queries.filter((q) => /schema_version/.test(q))).toHaveLength(1);
  });

  it('does not cache a failure forever', async () => {
    // A recovered database has to be able to say so.
    const { pool } = fakePool({ failOn: /schema_version/ });
    expect((await probeSchema(pool)).dbReachable).toBe(false);
    _resetSchemaReadyForTesting();
    const healthy = fakePool({ version: EXPECTED_SCHEMA_VERSION });
    expect((await probeSchema(healthy.pool)).dbReachable).toBe(true);
  });
});

describe('the wiring', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'index.ts'), 'utf8',
  ) as string;

  it('leaves the startup probe latched', () => {
    // A startup probe that could go false again would make Cloud Run tear down
    // a healthy instance over a transient blip.
    expect(src).toMatch(/app\.get\('\/startup-ready', readinessHandler\)/);
  });

  it('makes /ready ask live', () => {
    expect(src).toMatch(/app\.get\('\/ready'[\s\S]{0,200}probeSchema\(/);
  });

  it('probes on its own pool, so a saturated one cannot flap readiness', () => {
    // Reporting unready because the default pool is busy would pull the
    // instance out of rotation at exactly the moment load is highest.
    expect(src).toMatch(/probeSchema\(getPoolForService\('readiness'\)\)/);
  });

  it('does not treat draining as unready', () => {
    // An instance shedding load is finishing the work it already has; failing
    // readiness would take its in-flight requests with it.
    const ready = src.slice(src.indexOf("app.get('/ready'"));
    expect(ready.slice(0, 800)).toMatch(/const ready = probe\.dbReachable && probe\.schemaCurrent && drainController\.startupReady/);
  });
});
