// B.2 — Document-tool family unit tests.
//
// The document-side STANDARD tool is `tabular_extract` (LLM-extraction over
// document text — lives in src/tools/document-tool-handlers.ts and is
// dispatched from standard-tool-handler.ts case 'tabular_extract').
//
// The other "document-shaped" tool names from the plan (generate_pptx,
// generate_docx, generate_xlsx, read_document, find_in_document,
// read_presentation) are CONNECTOR tools (they carry a connector prefix
// like `google_drive__read_document`) and are exercised via the connector
// dispatch path, not the standard-tool switch. They're covered by the
// connector contract tests in C.3 — not this file. See system-prompt.ts
// for the connector-prefixed catalog filter.

jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    checkEntitlement: jest.fn().mockResolvedValue({ allowed: true }),
  }),
}));

jest.mock('../../llm/client', () => ({
  llmClient: {
    modelSelectionFor: (pair: { model?: string; provider?: string } | null | undefined) =>
      (pair?.model
        ? { provider: pair.provider ?? 'anthropic', model: pair.model }
        : (pair?.provider ? { provider: pair.provider } : {})),
    invoke: jest.fn().mockResolvedValue({ text: 'extracted-value' }),
  },
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
  getPoolForService: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
}));

import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: { writableLayers: [], readableLayers: [] },
  traceId: 'trace-1',
};

beforeEach(() => jest.clearAllMocks());

describe('tabular_extract — schema rejection', () => {
  it('rejects missing textContent', async () => {
    const r = await executeStandardTool('tabular_extract', {
      columns: [{ index: 0, name: 'X', format: 'string', prompt: 'p' }],
    }, ctx);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/textContent.*columns/i);
  });

  it('rejects missing columns', async () => {
    const r = await executeStandardTool('tabular_extract', {
      textContent: 'some doc',
      filename: 'x.pdf',
    }, ctx);
    expect(r?.success).toBe(false);
  });

  it('rejects empty columns', async () => {
    const r = await executeStandardTool('tabular_extract', {
      textContent: 'some doc',
      filename: 'x.pdf',
      columns: [],
    }, ctx);
    expect(r?.success).toBe(false);
  });
});

describe('tabular_extract — happy path', () => {
  it('returns success when the LLM extracts a value per column', async () => {
    const r = await executeStandardTool('tabular_extract', {
      textContent: 'Invoice for $1234, due 2026-12-31',
      filename: 'invoice.pdf',
      columns: [
        { index: 0, name: 'amount', format: 'currency', prompt: 'extract dollar amount' },
        { index: 1, name: 'due_date', format: 'date', prompt: 'extract due date' },
      ],
    }, ctx);
    expect(r?.success).toBe(true);
  });
});
