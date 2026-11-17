// Phase 6: Unit tests for the research_save_finding path in the standard
// tool handler. The existing memory_save / memory_retrieve handlers are
// already exercised indirectly through agent execution integration tests;
// these tests focus on the new research finding logic, in particular:
//
//   - 90-day default expiry when no expiration_date is provided
//   - Caller-provided expiration_date overrides the default when valid
//   - Past or malformed expiration_date falls back to the 90-day default
//   - Writable-layer enforcement (agent without role-layer write is denied)
//   - Category validation
//   - Structured tags (research-finding + category + optional source/relevance)

const mockSaveMemory = jest.fn();
const mockResolveRoleScopeKey = jest.fn().mockResolvedValue('HR Assistant');
jest.mock('../../memory/service', () => ({
  memoryService: {
    saveMemory: (...args: unknown[]) => mockSaveMemory(...args),
    resolveRoleScopeKey: (...args: unknown[]) => mockResolveRoleScopeKey(...args),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// research_save_finding now scans inputs through Cloud DLP for credentials
// before writing to memory. Stub the scan to "no findings" so the existing
// fixture-driven tests aren't blocked.
import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const TENANT_ID = 'tenant-phase6-001';
const AGENT_ID = 'agent-phase6-001';
const BASE_CTX: StandardToolContext = {
  tenantId: TENANT_ID,
  agentId: AGENT_ID,
  memoryScope: {
    writableLayers: ['individual', 'role'],
    readableLayers: ['individual', 'role', 'global'],
    scopeKeys: ['hr-agent'],
  },
  traceId: 'trace-abc',
};

const validPayload = {
  title: 'New GDPR guidance on data minimisation',
  summary: 'EDPB published guidance emphasising purpose-limitation review cycles.',
  details: 'The full guidance requires quarterly reviews of retention periods and justification.',
  source_url: 'https://edpb.europa.eu/example',
  source_name: 'EDPB',
  category: 'regulation',
  relevance_score: 0.8,
  action_items: ['Add retention review to Q2', 'Flag affected datasets'],
};

beforeEach(() => {
  mockSaveMemory.mockReset();
  mockSaveMemory.mockResolvedValue('memory-id-123');
});

describe('research_save_finding', () => {
  it('saves to role memory with a 90-day default expiry', async () => {
    const before = Date.now();
    const result = await executeStandardTool(
      'research_save_finding',
      validPayload,
      BASE_CTX,
    );
    const after = Date.now();

    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);

    const call = mockSaveMemory.mock.calls[0][0];
    expect(call.layer).toBe('role');
    expect(call.tenantId).toBe(TENANT_ID);
    expect(call.agentId).toBe(AGENT_ID);
    expect(call.scopeKey).toBe('hr-agent'); // first scopeKey from ctx

    const expiresAt: Date = call.expiresAt;
    expect(expiresAt).toBeInstanceOf(Date);

    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ninetyDaysMs - 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + ninetyDaysMs + 1000);
  });

  it('honours a valid future expiration_date from the payload', async () => {
    const futureIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await executeStandardTool(
      'research_save_finding',
      { ...validPayload, expiration_date: futureIso },
      BASE_CTX,
    );

    const call = mockSaveMemory.mock.calls[0][0];
    expect(call.expiresAt.toISOString()).toBe(futureIso);
  });

  it('falls back to 90-day default when expiration_date is in the past', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const before = Date.now();

    await executeStandardTool(
      'research_save_finding',
      { ...validPayload, expiration_date: past },
      BASE_CTX,
    );

    const call = mockSaveMemory.mock.calls[0][0];
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(call.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ninetyDaysMs - 1000);
  });

  it('falls back to 90-day default when expiration_date is malformed', async () => {
    await executeStandardTool(
      'research_save_finding',
      { ...validPayload, expiration_date: 'not-a-date' },
      BASE_CTX,
    );

    const call = mockSaveMemory.mock.calls[0][0];
    expect(call.expiresAt).toBeInstanceOf(Date);
    expect(call.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('builds structured tags with category, source, and relevance', async () => {
    await executeStandardTool('research_save_finding', validPayload, BASE_CTX);

    const call = mockSaveMemory.mock.calls[0][0];
    expect(call.tags).toEqual(
      expect.arrayContaining([
        'research-finding',
        'category:regulation',
        'source:EDPB',
        'relevance:0.80',
      ]),
    );
  });

  it('refuses to save when the agent lacks role-layer write access', async () => {
    const ctx: StandardToolContext = {
      ...BASE_CTX,
      memoryScope: {
        ...BASE_CTX.memoryScope,
        writableLayers: ['individual'],
      },
    };

    const result = await executeStandardTool(
      'research_save_finding',
      validPayload,
      ctx,
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/role.*memory layer/);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('rejects unknown categories', async () => {
    const result = await executeStandardTool(
      'research_save_finding',
      { ...validPayload, category: 'gossip' },
      BASE_CTX,
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/Invalid category/);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('rejects payloads missing required fields', async () => {
    const result = await executeStandardTool(
      'research_save_finding',
      { title: 'missing rest' },
      BASE_CTX,
    );

    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/requires/);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('builds content that includes title, summary, details, source, and action items', async () => {
    await executeStandardTool('research_save_finding', validPayload, BASE_CTX);

    const call = mockSaveMemory.mock.calls[0][0];
    const content: string = call.content;
    expect(content).toContain(validPayload.title);
    expect(content).toContain(validPayload.summary);
    expect(content).toContain(validPayload.details);
    expect(content).toContain('EDPB');
    expect(content).toContain('https://edpb.europa.eu/example');
    expect(content).toContain('Add retention review to Q2');
  });

  it('returns null for unhandled tool names (fallback to stub)', async () => {
    const result = await executeStandardTool(
      'some_other_tool',
      {},
      BASE_CTX,
    );
    expect(result).toBeNull();
  });
});

describe('research_save_finding keys the role layer by the role', () => {
  it('uses the team\'s role when the scope declares no key', async () => {
    mockSaveMemory.mockResolvedValueOnce({ memoryId: 'm-role' });
    mockResolveRoleScopeKey.mockResolvedValueOnce('HR Assistant');
    const ctx = { ...BASE_CTX, memoryScope: { ...BASE_CTX.memoryScope, scopeKeys: undefined } };
    const result = await executeStandardTool('research_save_finding', validPayload, ctx);
    expect(result?.success).toBe(true);
    expect(mockSaveMemory.mock.calls[0][0].scopeKey).toBe('HR Assistant');
  });

  it('refuses rather than parking the finding under the agent id when no role is recorded', async () => {
    mockResolveRoleScopeKey.mockResolvedValueOnce(null);
    const ctx = { ...BASE_CTX, memoryScope: { ...BASE_CTX.memoryScope, scopeKeys: undefined } };
    const result = await executeStandardTool('research_save_finding', validPayload, ctx);
    expect(result?.success).toBe(false);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });
});
