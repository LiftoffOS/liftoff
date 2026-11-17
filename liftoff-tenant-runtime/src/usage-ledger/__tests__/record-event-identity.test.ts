// A usage event is recorded whether or not the run has a workflow.
//
// `usage_events.workflow_id` and `.action_id` are nullable uuid columns
// (migration 081 dropped NOT NULL on workflow_id). A uuid column accepts a
// well-formed uuid or NULL and rejects a blank or a label, so the write must
// translate anything that is not an id into NULL — otherwise the INSERT fails
// and the per-step record is silently lost, since callers treat this write as
// non-fatal.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => mockQuery(...a) },
}));

import { UsageLedgerRepository } from '../repository';

const WF = '8d48512f-c961-4cee-87f2-a71e2664e8af';
const TASK = 'd347ba93-7e22-4cbe-8e6c-0f3ad65852a9';

function insertParams(): unknown[] {
  const call = mockQuery.mock.calls.find((c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO usage_events'));
  expect(call).toBeDefined();
  return call![1] as unknown[];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('recordEvent writes a real id or NULL to the uuid columns', () => {
  const base = { tenantId: 't1', agentId: 'a1', eventType: 'llm_step', credits: 0, metadata: {} };

  it('passes well-formed ids through', async () => {
    await new UsageLedgerRepository().recordEvent({ ...base, workflowId: WF, actionId: TASK } as never);
    const p = insertParams();
    expect(p[2]).toBe(WF);
    expect(p[3]).toBe(TASK);
  });

  it('translates a blank into NULL, keeping the record', async () => {
    await new UsageLedgerRepository().recordEvent({ ...base, workflowId: '', actionId: '' } as never);
    const p = insertParams();
    expect(p[2]).toBeNull();
    expect(p[3]).toBeNull();
  });

  it('translates a non-uuid label into NULL', async () => {
    await new UsageLedgerRepository().recordEvent({ ...base, workflowId: 'resume-hitl-abc', actionId: 'not-a-uuid' } as never);
    const p = insertParams();
    expect(p[2]).toBeNull();
    expect(p[3]).toBeNull();
  });

  it('translates absent into NULL', async () => {
    await new UsageLedgerRepository().recordEvent({ ...base, workflowId: undefined, actionId: null } as never);
    const p = insertParams();
    expect(p[2]).toBeNull();
    expect(p[3]).toBeNull();
  });
});
