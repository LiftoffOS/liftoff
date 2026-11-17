// Asserts that provisioning__record_event writes to hrbp_provisioning_events
// using exactly the columns the actual schema (migration 007) declares — and
// no others. Catches the C1 regression where the tool's INSERT referenced
// event_type/outcome/details (which don't exist).

import { handleProvisioningRecordEvent } from '../platform-agent/hrbp/tools/provisioning-record-event.js';
import type { HrbpToolContext } from '../platform-agent/hrbp/types.js';

jest.mock('../infrastructure/database.js', () => {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  return {
    getPool: () => ({ query }),
    __getQueryMock: () => query,
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const dbModule = require('../infrastructure/database.js');
const query: jest.Mock = dbModule.__getQueryMock();

const ctx: HrbpToolContext = {
  tenantId: '00000000-0000-0000-0000-0000000000aa',
  planId:   '00000000-0000-0000-0000-0000000000bb',
  runId:    '00000000-0000-0000-0000-0000000000cc',
  specId:   'spec-1',
  approverAccountId: 'acct-1',
  spec: {
    specId: 'spec-1',
    name: 'Test Agent',
    agentType: 'agent',
    roleSummary: 'Test',
  },
};

describe('handleProvisioningRecordEvent', () => {
  beforeEach(() => query.mockClear());

  it('inserts into hrbp_provisioning_events with the canonical column list', async () => {
    await handleProvisioningRecordEvent(
      { step: 'distill', status: 'completed' },
      ctx,
    );
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    // Real columns must all be present.
    for (const col of ['run_id', 'plan_id', 'tenant_id', 'spec_id', 'step', 'status']) {
      expect(sql).toContain(col);
    }
    // Bogus columns from the pre-fix version must NEVER appear.
    expect(sql).not.toMatch(/\bevent_type\b/);
    expect(sql).not.toMatch(/\boutcome\b/);
    expect(sql).not.toMatch(/\bdetails\b/);
  });

  it('passes the runId from context as the first FK param', async () => {
    await handleProvisioningRecordEvent(
      { step: 'create_agent', status: 'in_progress' },
      ctx,
    );
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(ctx.runId);
    expect(params[1]).toBe(ctx.planId);
    expect(params[2]).toBe(ctx.tenantId);
    expect(params[3]).toBe(ctx.specId);
    expect(params[4]).toBe('create_agent');
    expect(params[5]).toBe('in_progress');
  });

  it('forwards optional internalAgentId / idempotencyKey / errorMessage', async () => {
    await handleProvisioningRecordEvent(
      {
        step: 'create_agent',
        status: 'failed',
        internalAgentId: 'ag-1',
        idempotencyKey: 'idem-1',
        errorMessage: 'PB unavailable',
      },
      ctx,
    );
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[6]).toBe('ag-1');
    expect(params[7]).toBe('idem-1');
    expect(params[8]).toBe('PB unavailable');
  });

  it('defaults optional fields to null when omitted', async () => {
    await handleProvisioningRecordEvent(
      { step: 'distill', status: 'pending' },
      ctx,
    );
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[6]).toBeNull();
    expect(params[7]).toBeNull();
    expect(params[8]).toBeNull();
  });
});
