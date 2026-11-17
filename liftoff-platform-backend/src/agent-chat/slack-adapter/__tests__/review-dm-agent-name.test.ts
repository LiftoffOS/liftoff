// An approval card must name the team that is asking.
//
// internal_agents.id and the runtime's agents.id are disjoint (INV-TR-010).
// Approvals raised by the runtime carry the RUNTIME id — it comes straight off
// ExecutionContext.agentId — so an internal_agents lookup finds nothing and
// every one of those cards falls through to the literal 'Agent'. The card then
// reads "Agent: Agent": an approval request that never says which team
// wants what, which is unusable the moment a workspace has more than one team.

const queryMock = jest.fn<(...a: unknown[]) => Promise<{ rows: unknown[] }>>();
jest.mock('../../../infrastructure/database', () => ({
  withTenantScope: (_t: unknown, fn: (c: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const getMapMock = jest.fn<(t: string) => Promise<Map<string, string>>>();
jest.mock('../../../internal-agents/runtime-agent-id-map', () => ({
  getRuntimeToInternalMap: (t: string) => getMapMock(t),
}));

import { __loadAgentDisplayNameForTest as loadAgentDisplayName } from '../review-dm-notifier';

const TENANT = 'tenant-1';
const RUNTIME_ID = '93321b38-ead6-4f71-84f1-9a08ba2a2b5f';
const INTERNAL_ID = '122662dd-de4e-4b0d-8873-50cd6a00daaf';

beforeEach(() => {
  jest.clearAllMocks();
  getMapMock.mockResolvedValue(new Map());
});

describe('the approval card names the team', () => {
  it('names it when given the control-plane id', async () => {
    queryMock.mockResolvedValue({ rows: [{ display_name: 'Code Reviewer' }] });
    await expect(loadAgentDisplayName(TENANT, INTERNAL_ID)).resolves.toBe('Code Reviewer');
  });

  it('names it when given the RUNTIME id, by translating', async () => {
    // The regression: this is the id the runtime actually sends.
    queryMock
      .mockResolvedValueOnce({ rows: [] })                                   // direct lookup misses
      .mockResolvedValueOnce({ rows: [{ display_name: 'Code Reviewer' }] }); // after translation
    getMapMock.mockResolvedValue(new Map([[RUNTIME_ID, INTERNAL_ID]]));

    await expect(loadAgentDisplayName(TENANT, RUNTIME_ID)).resolves.toBe('Code Reviewer');
    expect(getMapMock).toHaveBeenCalledWith(TENANT);
  });

  it('falls back only when the id resolves in neither space', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(loadAgentDisplayName(TENANT, 'unknown-id')).resolves.toBe('Agent');
  });

  it('still renders a card when the translation map is unavailable', async () => {
    // A map failure must not take down the notification — an anonymous card
    // beats no card at all when somebody is waiting to approve something.
    queryMock.mockResolvedValue({ rows: [] });
    getMapMock.mockRejectedValue(new Error('runtime unreachable'));
    await expect(loadAgentDisplayName(TENANT, RUNTIME_ID)).resolves.toBe('Agent');
  });
});
