// Behavioural regression for the id-space defect.
//
// `invocations.agent_id` holds the RUNTIME agents.id; the Platform Backend
// addresses the agent by `internal_agents.id`. The stop route looked the live
// run up with the caller's internal id, matched zero rows, and answered
// `deliveredAs: 'noop'` — a Stop button that did nothing, with no error
// anywhere. The interrupt lookup next to it failed the same way and surfaced
// as a 409 "concurrent turn in progress".
//
// The fake pool below is the whole point: it models the two id spaces as they
// actually are — the invocation row is reachable ONLY by the runtime id. A
// handler that forwards the caller's id finds nothing and the test fails.
// The previous coverage asserted the source text matched a regex, which says
// nothing about which id reaches the database.

import express from 'express';
import request from 'supertest';

const INTERNAL_ID = '5e4acb47-c63b-4f3f-a90d-aedcedbda8eb';
const RUNTIME_ID = 'abbb7a1c-f66f-46d8-b65a-e2e52ea77568';
const TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const THREAD_ID = '7b9d446d-2f0e-4a44-9c1e-2b7a5f0c1d33';
const INVOCATION_ID = '627da69d-5f8a-4a2b-9f31-0c7d4e2a1b55';

interface RecordedQuery { sql: string; params: unknown[] }
const queries: RecordedQuery[] = [];

// Whether anything is heartbeating this thread's turn lock. Liveness is READ from
// that row now, not inferred from `invocations.completed_at IS NULL`
// (INV-PB-018), so the fake pool has to model it: an open invocation whose writer
// died is exactly the case the bound exists for, and before the lock read it was
// indistinguishable from a run that is still going.
let lockIsLive = true;

const fakePool = {
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });

    if (/FROM chat_turn_locks/i.test(sql)) {
      return lockIsLive
        ? { rows: [{ acquired_by_invocation_id: INVOCATION_ID }] }
        : { rows: [] };
    }
    if (/FROM invocations/i.test(sql)) {
      // The live run exists in RUNTIME space only. This is the real schema
      // behaviour: a control-plane id simply matches nothing. The lookup is also
      // bounded to the invocation the lock names, so an open row that nothing is
      // serving does not answer.
      const agentIdParam = params[2];
      const boundToInvocation = params[3];
      const agentMatches = agentIdParam === RUNTIME_ID;
      const invocationMatches = boundToInvocation === undefined
        || boundToInvocation === INVOCATION_ID;
      return agentMatches && invocationMatches
        ? { rows: [{ id: INVOCATION_ID }] }
        : { rows: [] };
    }
    if (/INSERT INTO agent_invocation_signals/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }),
};

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => fakePool,
}));

jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveRuntimeAgentId: jest.fn(async (_tenantId: string, internalId: string) =>
    (internalId === INTERNAL_ID ? RUNTIME_ID : internalId)),
  resolveRuntimeAgentIdStrict: jest.fn(async () => RUNTIME_ID),
  resolveInternalAgentId: jest.fn(async () => INTERNAL_ID),
}));

jest.mock('../../security/service-auth', () => ({
  requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../startup/schema-check', () => ({
  isSchemaReady: () => true,
}));

// Imported after the mocks are registered.
import { chatTurnRouter } from '../chat-turn-handler';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(chatTurnRouter);
  return app;
}

describe('POST /:agentId/stop — agent id space (ADR-039 / INV-TR-010)', () => {
  beforeEach(() => {
    queries.length = 0;
    lockIsLive = true;
    fakePool.query.mockClear();
  });

  it('finds the live run when addressed by the INTERNAL agent id and records the abort', async () => {
    const res = await request(makeApp())
      .post(`/${INTERNAL_ID}/stop`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID });

    expect(res.status).toBe(200);
    // 'noop' is the pre-fix answer: the lookup matched nothing.
    expect(res.body).toEqual({ acknowledged: true, deliveredAs: 'abort' });

    const signal = queries.find((q) => /INSERT INTO agent_invocation_signals/i.test(q.sql));
    expect(signal).toBeDefined();
    expect(signal?.params[0]).toBe(INVOCATION_ID);
    expect(signal?.sql).toMatch(/'abort'/);
  });

  it('never queries invocations with the caller-supplied internal id', async () => {
    await request(makeApp())
      .post(`/${INTERNAL_ID}/stop`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID });

    const lookups = queries.filter((q) => /FROM invocations/i.test(q.sql));
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) {
      expect(lookup.params).not.toContain(INTERNAL_ID);
      expect(lookup.params).toContain(RUNTIME_ID);
    }
  });

  // The interrupt half of the same defect: a message sent while the run is
  // live must be folded into that run. Addressed by the internal id, the
  // lookup found nothing, the request fell through to the per-thread lock, and
  // the user got 409 "concurrent turn in progress" — the shape that made this
  // feature look implemented while never once working from the product.
  it('folds a mid-run message into the live run when addressed by the INTERNAL id', async () => {
    const res = await request(makeApp())
      .post(`/${INTERNAL_ID}/chat-turn`)
      .send({
        tenantId: TENANT_ID,
        agentId: INTERNAL_ID,
        threadId: THREAD_ID,
        invocationId: INVOCATION_ID,
        channelHint: 'web',
        userId: 'u1',
        userDisplayName: 'Tester',
        userRole: 'member',
        userMessage: 'actually, focus on the second option instead',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ acknowledged: true, deliveredAs: 'interrupt' });

    const signal = queries.find((q) => /INSERT INTO agent_invocation_signals/i.test(q.sql));
    expect(signal?.params[0]).toBe(INVOCATION_ID);
    expect(signal?.sql).toMatch(/'user_message'/);

    const lookups = queries.filter((q) => /FROM invocations/i.test(q.sql));
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) expect(lookup.params).not.toContain(INTERNAL_ID);
  });

  // The bound the lock read adds, and the reason it was required rather than
  // optional. `completed_at IS NULL` is the same defect class as an unexpired
  // lease in its UNBOUNDED form: a lease at least expires, whereas a row whose
  // writer died is never completed by anyone. So a single crashed turn swallowed
  // every subsequent message on its thread forever — a wedge with no end date
  // — and the lock is what makes the answer expire.
  it('reports noop when the invocation is open but nothing is serving the thread', async () => {
    lockIsLive = false;

    const res = await request(makeApp())
      .post(`/${INTERNAL_ID}/stop`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID });

    expect(res.body).toEqual({ acknowledged: true, deliveredAs: 'noop' });
    expect(queries.some((q) => /INSERT INTO agent_invocation_signals/i.test(q.sql))).toBe(false);
    // And it did not even ask: the lock answered first, so a dead run's id is
    // never a candidate to address a signal to.
    expect(queries.some((q) => /FROM invocations/i.test(q.sql))).toBe(false);
  });

  it('reports noop rather than a false success when no run is active', async () => {
    fakePool.query.mockImplementationOnce(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [] };
    });

    const res = await request(makeApp())
      .post(`/${INTERNAL_ID}/stop`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID });

    expect(res.body).toEqual({ acknowledged: true, deliveredAs: 'noop' });
    expect(queries.some((q) => /INSERT INTO agent_invocation_signals/i.test(q.sql))).toBe(false);
  });
});
