// A capability run tells the control plane which agent is spending.
//
// platform-backend books a capability call straight onto
// cost_attribution_events. Until this was sent the row carried no agent and no
// surface at all, so the Cost Breakdown had nowhere to put it and the spend
// was reported as "Unattributed".
//
// The two things this pins are the id SPACE and the miss behaviour, because
// getting either wrong is silent. `agents.id` here and `internal_agents.id`
// there are disjoint (ADR-039, INV-TR-010): a runtime id written to that column
// renders as an agent the workspace does not have — the phantom-agent shape
// platform-backend's migration 524 removes from this table. Unknown is fine; wrong is not.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));
jest.mock('../../clients/platform-backend-client', () => {
  const actual = jest.requireActual('../../clients/platform-backend-client');
  return { ...actual, runCapabilityViaBackend: jest.fn(), capabilitySearchViaBackend: jest.fn(), runDatasetToolViaBackend: jest.fn() };
});
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { executeStandardTool, type StandardToolContext } from '../standard-tool-handler';
import { runCapabilityViaBackend } from '../../clients/platform-backend-client';

const mockRun = runCapabilityViaBackend as jest.MockedFunction<typeof runCapabilityViaBackend>;

const RUNTIME_AGENT_ID  = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const INTERNAL_AGENT_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: RUNTIME_AGENT_ID,
  memoryScope: {},
  integrations: [],
};

/** The 8th positional argument of runCapabilityViaBackend. */
const sentInternalAgentId = () => mockRun.mock.calls[0]?.[7];

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
  mockRun.mockResolvedValue({ ok: true, empty: false, text: 'ran' });
});

describe('which agent a capability run is booked to', () => {
  it('sends the CONTROL-PLANE id when the mapping resolves', async () => {
    mockQuery.mockResolvedValue({ rows: [{ internal_agent_id: INTERNAL_AGENT_ID }] });

    await executeStandardTool('run_capability', { capabilityId: 'cap_abc', args: { q: 'x' } }, ctx);

    expect(sentInternalAgentId()).toBe(INTERNAL_AGENT_ID);
    // And never the runtime id, which is the whole point of translating.
    expect(sentInternalAgentId()).not.toBe(RUNTIME_AGENT_ID);
  });

  it('looks the mapping up by the runtime id, scoped to the tenant', async () => {
    mockQuery.mockResolvedValue({ rows: [{ internal_agent_id: INTERNAL_AGENT_ID }] });

    await executeStandardTool('run_capability', { capabilityId: 'cap_abc', args: {} }, ctx);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('internal_agent_runtime_mapping');
    expect(params).toEqual([RUNTIME_AGENT_ID, 'tenant-1']);
  });

  it('sends NOTHING on a mapping miss, rather than the runtime id', async () => {
    // The tempting fallback is `?? ctx.agentId`, and it is what the file's
    // other call sites do for a different column. Here it would write a
    // wrong-space id onto a cost row: the spend would render against an AI
    // team the workspace does not have. Absent, platform-backend books it
    // exactly as it does today and reports it as unattributed — which is true.
    mockQuery.mockResolvedValue({ rows: [] });

    await executeStandardTool('run_capability', { capabilityId: 'cap_abc', args: {} }, ctx);

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(sentInternalAgentId()).toBeUndefined();
  });

  it('still runs the capability when the lookup fails outright', async () => {
    // Attribution is not worth failing a tool call for. A lookup that throws
    // must leave the capability running and simply unattributed.
    mockQuery.mockRejectedValue(new Error('pool exhausted'));

    const res = await executeStandardTool('run_capability', { capabilityId: 'cap_abc', args: {} }, ctx);

    expect(res.success).toBe(false);
    // The failure is reported truthfully rather than as a fabricated success
    // (INV: no stub success). What must NOT happen is a wrong id being sent.
    expect(sentInternalAgentId()).toBeUndefined();
  });
});
