// The external-agent path's own checkHitlGate.
//
// 1b: the effect class the control plane stored for the agent's tool is
// appended to the categories the gate reads, so the runtime's level-2
// destructive rule and the effect-based checks see it. Appended, never
// replacing; absent → unchanged.
//
// Contract check: the model chose the call itself, so the gate is handed the
// instructions contract off the calling run's compiled instruction row and
// the owning invocation; an inbound request (version 0) has no run to judge
// against and passes nothing.

jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const checkHitlGateMock = jest.fn();
jest.mock('../../hitl-enforcement/service', () => ({
  hitlEnforcementService: {
    getOversightSettings: jest.fn().mockResolvedValue(undefined),
    resolveHitlLevel: jest.fn().mockResolvedValue(2),
    checkHitlGate: (...a: unknown[]) => checkHitlGateMock(...a),
  },
}));
const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => ({ query: (...a: unknown[]) => queryMock(...a) }) }));

import { ExternalAgentHandler, appendEffectClass, type ExternalAgentConfig } from '../external-agent-handler';

beforeEach(() => {
  jest.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [] });
});

const config = {
  id: 'ext-1', tenantId: 't1', name: 'crm', endpointUrl: 'https://x', transportType: 'streamable-http', authType: 'none',
  collaborationMode: 'request_help', allowedInternalAgentIds: [], requestRules: [],
  toolClassifications: { delete_record: ['dataChanges'] },
  toolEffectClasses: { delete_record: 'destructive' },
  rawMcpTools: [{ name: 'delete_record', description: 'Deletes', inputSchema: { type: 'object' } }],
  status: 'connected', summary: null, collaborationHints: null,
} as unknown as ExternalAgentConfig;
const gateOf = (handler: ExternalAgentHandler) =>
  (handler as unknown as { checkHitlGate: (i: unknown, c: ExternalAgentConfig) => Promise<unknown> }).checkHitlGate.bind(handler);

describe('appendEffectClass', () => {
  it('appends a known class once and preserves the existing categories', () => {
    expect(appendEffectClass(['dataChanges'], 'destructive')).toEqual(['dataChanges', 'destructive']);
    expect(appendEffectClass(['read'], 'read')).toEqual(['read']);
    expect(appendEffectClass([], undefined)).toEqual([]);
    expect(appendEffectClass(['dataChanges'], 'unclear')).toEqual(['dataChanges']);
  });
});

describe('the external-agent gate sees the appended effect', () => {
  it('passes the tool to checkHitlGate with the effect class beside the categories', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: true, reason: 'destructive_gate' });
    const handler = new ExternalAgentHandler();
    const gate = await gateOf(handler)({ tenantId: 't1', agentId: 'ra-1', instructionVersion: 3, toolName: 'delete_record', toolInput: {} }, config);
    expect(gate).toEqual({ shouldGate: true, reason: 'destructive_gate' });
    const tools = checkHitlGateMock.mock.calls[0][3] as Array<{ name: string; categories: string[] }>;
    expect(tools[0]).toMatchObject({ name: 'crm:delete_record', categories: ['dataChanges', 'destructive'] });
  });

  it('a payload with no effect class (an older control plane, or the flag off) leaves the categories as today', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    const handler = new ExternalAgentHandler();
    const config = {
      id: 'ext-1', tenantId: 't1', name: 'crm', endpointUrl: 'https://x', transportType: 'streamable-http', authType: 'none',
      collaborationMode: 'request_help', allowedInternalAgentIds: [], requestRules: [],
      toolClassifications: { enrich_company: [] },
      rawMcpTools: [{ name: 'enrich_company', description: 'Enrich', inputSchema: { type: 'object' } }],
      status: 'connected', summary: null, collaborationHints: null,
    } as unknown as ExternalAgentConfig;
    await gateOf(handler)({ tenantId: 't1', agentId: 'ra-1', instructionVersion: 3, toolName: 'enrich_company', toolInput: {} }, config);
    const tools = checkHitlGateMock.mock.calls[0][3] as Array<{ categories: string[] }>;
    expect(tools[0].categories).toEqual([]);
  });
});

describe('the external-agent gate carries the calling run\'s contract', () => {
  it('hands checkHitlGate the instructions contract off the compiled instruction row, and the owning invocation', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    queryMock.mockResolvedValue({ rows: [{
      system_prompt: 'You are the Sales Ops Analyst for Acme.\n\n## Tone\nTerse.',
      user_instructions: 'Enrich every new lead before the daily digest.',
      instructions_md: '## Role\nYou are running as the Sales Ops Analyst for Acme.\n\n## Tool-use guidance\nRead before you write.',
    }] });
    await gateOf(new ExternalAgentHandler())(
      { tenantId: 't1', agentId: 'ra-1', instructionVersion: 3, invocationId: 'inv-9', toolName: 'delete_record', toolInput: {} }, config,
    );
    // The row the input names: runtime agents.id and version, tenant-scoped.
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('FROM compiled_instructions'), ['t1', 'ra-1', 3]);
    expect(checkHitlGateMock.mock.calls[0][5]).toBeUndefined();
    expect(checkHitlGateMock.mock.calls[0][6]).toEqual({
      contract: {
        kind: 'instructions',
        instructions: 'Enrich every new lead before the daily digest.',
        role: '## Role\nYou are running as the Sales Ops Analyst for Acme.\n\nYou are the Sales Ops Analyst for Acme.',
      },
      invocationId: 'inv-9',
    });
  });

  it('an inbound request (version 0) and a missing row pass no contract, and a read failure decides as today', async () => {
    checkHitlGateMock.mockResolvedValue({ shouldGate: false });
    const gate = gateOf(new ExternalAgentHandler());
    await gate({ tenantId: 't1', agentId: 'ra-1', instructionVersion: 0, toolName: 'delete_record', toolInput: {} }, config);
    expect(queryMock).not.toHaveBeenCalled();
    expect(checkHitlGateMock.mock.calls[0][6]).toEqual({});

    await gate({ tenantId: 't1', agentId: 'ra-1', instructionVersion: 3, toolName: 'delete_record', toolInput: {} }, config);
    expect(checkHitlGateMock.mock.calls[1][6]).toEqual({});

    queryMock.mockRejectedValueOnce(new Error('connection reset'));
    const result = await gate({ tenantId: 't1', agentId: 'ra-1', instructionVersion: 3, invocationId: 'inv-9', toolName: 'delete_record', toolInput: {} }, config);
    expect(result).toEqual({ shouldGate: false });
    expect(checkHitlGateMock.mock.calls[2][6]).toEqual({ invocationId: 'inv-9' });
  });
});
