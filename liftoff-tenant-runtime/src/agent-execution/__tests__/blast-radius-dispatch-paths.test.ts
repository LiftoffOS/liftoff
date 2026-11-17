// Every path that can change something is measured against the SAME total.
//
// Three dispatch paths reach a connector: the LLM loop, the batched workflow
// path, and agent-authored sandbox code arriving over HTTP from the sidecar.
// A fourth hands work to an external agent. Covering only the first two leaves
// an agent able to do unbounded damage by routing through the third — and the
// gap would be invisible, because the covered paths would keep reporting
// small, correct numbers.
//
// These tests use the shared store directly, which is the thing that makes the
// paths share anything at all.

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ logger: mockLog }));

const store = new Map<string, { entitiesTouched: number; destructiveOps: number; clearedFields: number }>();
jest.mock('../blast-radius-store', () => ({
  readRunTotals: async (tenantId: string, invocationId: string) =>
    store.get(`${tenantId}:${invocationId}`) ?? { entitiesTouched: 0, destructiveOps: 0, clearedFields: 0 },
  incrementRunTotals: async (
    tenantId: string,
    invocationId: string,
    batch: { entitiesTouched: number; destructiveOps: number; clearedFields: number },
  ) => {
    const key = `${tenantId}:${invocationId}`;
    const cur = store.get(key) ?? { entitiesTouched: 0, destructiveOps: 0, clearedFields: 0 };
    const next = {
      entitiesTouched: cur.entitiesTouched + batch.entitiesTouched,
      destructiveOps: cur.destructiveOps + batch.destructiveOps,
      clearedFields: cur.clearedFields + batch.clearedFields,
    };
    store.set(key, next);
    return next;
  },
}));

import { commitBlastRadius, evaluateBlastRadius } from '../blast-radius-gate';

const TENANT = 't1';
const INVOCATION = 'inv-1';

/** Each dispatch path builds its own state object — that is the point. They
 *  share nothing except the persisted row. */
const pathState = (agentId: string) => ({
  context: { tenantId: TENANT, agentId, invocationId: INVOCATION },
});

const del = (n: number) => [{
  name: 'crm__delete_record',
  input: { ids: Array.from({ length: n }, (_, i) => `id-${i}`) },
}];

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  process.env.QUANTIFIER_MODE = 'enforce';
  process.env.QUANTIFIER_MAX_DESTRUCTIVE = '10';
  process.env.QUANTIFIER_MAX_ENTITIES = '1000';
  process.env.QUANTIFIER_MAX_PER_BATCH = '1000';
});

afterEach(() => {
  delete process.env.QUANTIFIER_MODE;
  delete process.env.QUANTIFIER_MAX_DESTRUCTIVE;
  delete process.env.QUANTIFIER_MAX_ENTITIES;
  delete process.env.QUANTIFIER_MAX_PER_BATCH;
});

describe('one run, several dispatch paths', () => {
  it('a sandbox script cannot finish what the LLM loop was stopped from doing', async () => {
    // The LLM loop deletes 8 — under the bound of 10, so it proceeds.
    const llm = pathState('agent-1');
    const first = await evaluateBlastRadius(llm, del(8), 'per-call');
    expect(first!.shouldGate).toBe(false);
    await commitBlastRadius(llm, del(8));

    // The script then tries 5 more. Its own state knows nothing about the 8,
    // but the run's total does — and 13 is over.
    const sandbox = pathState('agent-1');
    const second = await evaluateBlastRadius(sandbox, del(5), 'sandbox-dispatch');
    expect(second!.shouldGate).toBe(true);
    expect(second!.quantification.cumulative.destructiveOps).toBe(13);
  });

  it('external-agent calls accumulate into the same run total', async () => {
    const llm = pathState('agent-1');
    await commitBlastRadius(llm, del(6));

    const external = pathState('agent-1');
    await commitBlastRadius(external, [
      { name: 'partner:delete_thing', input: { id: 'a' } },
    ]);

    const next = await evaluateBlastRadius(pathState('agent-1'), del(1), 'per-call');
    expect(next!.quantification.cumulative.destructiveOps).toBe(8);
  });

  it('the batched path sees what the per-call path already spent', async () => {
    const perCall = pathState('agent-1');
    for (let i = 0; i < 9; i++) {
      await commitBlastRadius(perCall, [{ name: 'crm__delete_record', input: { id: `d${i}` } }]);
    }

    // A fresh state, as a resumed run would have.
    const batched = pathState('agent-1');
    const decision = await evaluateBlastRadius(batched, del(2), 'batched-dispatch');
    expect(decision!.shouldGate).toBe(true);
  });

  it('a run that never dispatched measures from zero', async () => {
    const decision = await evaluateBlastRadius(pathState('agent-1'), del(3), 'per-call');
    expect(decision!.shouldGate).toBe(false);
    expect(decision!.quantification.cumulative.destructiveOps).toBe(3);
  });

  it('separate runs of the same agent do not contaminate each other', async () => {
    const runA = { context: { tenantId: TENANT, agentId: 'agent-1', invocationId: 'run-a' } };
    const runB = { context: { tenantId: TENANT, agentId: 'agent-1', invocationId: 'run-b' } };

    await commitBlastRadius(runA, del(20));
    const decision = await evaluateBlastRadius(runB, del(1), 'per-call');
    expect(decision!.shouldGate).toBe(false);
  });
});
