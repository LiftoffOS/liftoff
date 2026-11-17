import { resetConfigForTests } from '../infrastructure/config.js';
import { agentTemplatesListTool } from '../workforce-plans/tools/agent-templates-list.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

const mockCtx: WorkforcePlanToolContext = {
  tenantId: 'tenant-123',
  accountId: 'account-123',
  role: 'owner',
};

const mockTemplate = {
  id: 'sales-development-representative',
  displayName: 'Sales Development Representative',
  description: 'Researches prospects and drafts outreach.',
  departmentCategory: 'sales',
  defaultAgentType: 'agent',
  requiredConnectors: [{ id: 'req-sf', connectorType: 'salesforce', role: 'data_source', description: 'CRM' }],
  optionalConnectors: [{ id: 'opt-sl', connectorType: 'slack', role: 'tool', description: 'Alerts' }],
  role: 'Sales Development Representative',
  responsibilities: '## Responsibilities\nResearch prospects.',
  additionalContext: '## Rules\nAsk before sending.',
  roleSummary: 'Researches qualified prospects and drafts outreach emails.',
};

describe('agentTemplatesListTool', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    resetConfigForTests();
    process.env['PLATFORM_BACKEND_URL'] = 'http://localhost:3000';
    process.env['GCP_PROJECT_ID'] = 'test';
    process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:us-west1:test-db';
    process.env['WORKFORCE_SERVICE_TOKEN'] = 'test-service-auth';
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env['PLATFORM_BACKEND_URL'];
    delete process.env['GCP_PROJECT_ID'];
    delete process.env['DB_INSTANCE_CONNECTION_NAME'];
    delete process.env['WORKFORCE_SERVICE_TOKEN'];
    resetConfigForTests();
  });

  it('returns summarised templates from PB response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ templates: [mockTemplate], hasMore: false }),
    } as Response);

    const result = await agentTemplatesListTool.execute({}, mockCtx) as {
      templates: Array<{
        id: string; displayName: string; description: string;
        departmentCategory: string; defaultAgentType: string;
        requiredConnectorCount: number; optionalConnectorCount: number;
      }>;
      hasMore: boolean;
      message: string;
    };

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].id).toBe('sales-development-representative');
    expect(result.templates[0].requiredConnectorCount).toBe(1);
    expect(result.templates[0].optionalConnectorCount).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it('sends X-Service-Auth header with WORKFORCE_SERVICE_TOKEN', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ templates: [], hasMore: false }),
    } as Response);

    await agentTemplatesListTool.execute({}, mockCtx);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/internal/agent-templates'),
      expect.objectContaining({ headers: { 'X-Service-Auth': 'test-service-auth' } }),
    );
  });

  it('targets /api/internal/agent-templates', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ templates: [], hasMore: false }),
    } as Response);

    await agentTemplatesListTool.execute({}, mockCtx);

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('http://localhost:3000/api/internal/agent-templates');
  });

  it('forwards hasMore and nextCursor from PB response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ templates: [mockTemplate], hasMore: true, nextCursor: 'cursor-abc' }),
    } as Response);

    const result = await agentTemplatesListTool.execute({}, mockCtx) as {
      hasMore: boolean; nextCursor?: string; message: string;
    };

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe('cursor-abc');
  });

  it('includes departmentCategory in request URL when provided', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ templates: [], hasMore: false }),
    } as Response);

    await agentTemplatesListTool.execute({ departmentCategory: 'sales' }, mockCtx);

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('departmentCategory=sales');
  });

  it('returns error object (no throw) when PB returns 400 for invalid department', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 400,
      json: async () => ({ error: 'Invalid departmentCategory', validValues: ['sales', 'hr'] }),
    } as Response);

    const result = await agentTemplatesListTool.execute(
      { departmentCategory: 'invalid_dept' as never },
      mockCtx,
    ) as { error: string; validValues: string[] };

    expect(result.error).toBe('Invalid departmentCategory');
    expect(result.validValues).toContain('sales');
  });

  it('throws when PB returns 401', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    } as Response);

    await expect(agentTemplatesListTool.execute({}, mockCtx)).rejects.toThrow('401');
  });

  it('throws on unexpected non-200 non-400 HTTP status', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 503,
      json: async () => ({}),
    } as Response);

    await expect(agentTemplatesListTool.execute({}, mockCtx)).rejects.toThrow('503');
  });

  it('returns "No templates found" message when templates array is empty', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ templates: [], hasMore: false }),
    } as Response);

    const result = await agentTemplatesListTool.execute({ departmentCategory: 'finance' }, mockCtx) as {
      message: string;
    };

    expect(result.message).toContain('No templates found');
  });
});
