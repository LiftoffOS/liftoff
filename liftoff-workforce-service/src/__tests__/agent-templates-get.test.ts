import { resetConfigForTests } from '../infrastructure/config.js';
import { agentTemplatesGetTool } from '../workforce-plans/tools/agent-templates-get.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

const mockCtx: WorkforcePlanToolContext = {
  tenantId: 'tenant-123',
  accountId: 'account-123',
  role: 'owner',
};

const mockFullTemplate = {
  id: 'sales-development-representative',
  displayName: 'Sales Development Representative',
  description: 'Researches prospects and drafts outreach.',
  roleSummary: 'Researches qualified prospects and drafts outreach emails for human approval.',
  departmentCategory: 'sales',
  defaultAgentType: 'agent',
  role: 'Sales Development Representative',
  responsibilities: '## Responsibilities\nResearch prospects in Salesforce.',
  additionalContext: '## Rules\nNever send without approval.',
  requiredConnectors: [
    { id: 'req-sf', connectorType: 'salesforce', role: 'data_source', description: 'CRM data source' },
  ],
  optionalConnectors: [
    { id: 'opt-sl', connectorType: 'slack', role: 'tool', description: 'Alerts' },
  ],
  escalationPatterns: [
    { trigger: 'Prospect replies with interest', action: 'hitl', description: 'Route to AE' },
  ],
  defaultTriggerConfig: { type: 'manual' },
};

describe('agentTemplatesGetTool', () => {
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

  it('returns found: true with all template fields on success', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => mockFullTemplate,
    } as Response);

    const result = await agentTemplatesGetTool.execute(
      { templateId: 'sales-development-representative' },
      mockCtx,
    ) as { found: true; roleSummary: string; responsibilities: string; requiredConnectors: unknown[] };

    expect(result.found).toBe(true);
    expect(result.roleSummary).toBe('Researches qualified prospects and drafts outreach emails for human approval.');
    expect(result.responsibilities).toContain('Salesforce');
    expect(result.requiredConnectors).toHaveLength(1);
  });

  it('sends X-Service-Auth header with WORKFORCE_SERVICE_TOKEN', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => mockFullTemplate,
    } as Response);

    await agentTemplatesGetTool.execute({ templateId: 'sales-development-representative' }, mockCtx);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { 'X-Service-Auth': 'test-service-auth' } }),
    );
  });

  it('targets /api/internal/agent-templates/:id', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => mockFullTemplate,
    } as Response);

    await agentTemplatesGetTool.execute({ templateId: 'sales-development-representative' }, mockCtx);

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/api/internal/agent-templates/sales-development-representative');
  });

  it('includes templateId in the URL path', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ ...mockFullTemplate, id: 'code-reviewer' }),
    } as Response);

    await agentTemplatesGetTool.execute({ templateId: 'code-reviewer' }, mockCtx);

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain('code-reviewer');
  });

  it('returns found: false (no throw) when PB returns 404', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 404,
      json: async () => ({ error: 'Template not found' }),
    } as Response);

    const result = await agentTemplatesGetTool.execute(
      { templateId: 'nonexistent-template' },
      mockCtx,
    ) as { found: false; message: string };

    expect(result.found).toBe(false);
    expect(result.message).toContain('nonexistent-template');
    expect(result.message).toContain('agent_templates__list');
  });

  it('throws on unexpected non-404 HTTP errors', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 500,
      json: async () => ({}),
    } as Response);

    await expect(
      agentTemplatesGetTool.execute({ templateId: 'some-template' }, mockCtx),
    ).rejects.toThrow('500');
  });
});
