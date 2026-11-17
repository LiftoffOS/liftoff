// `tabular_enumerate` — many rows out of one document.
//
// The sibling tool, `tabular_extract`, produces one row per document by fanning
// out per column. This one cannot: the row count is whatever the document says,
// so it reads once and parses an array back. Everything below is about that
// array surviving contact with a model — fences, prose, missing keys, a runaway
// count — because a row that silently vanishes is worse than no table.

jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: jest.fn().mockReturnValue({
    getModelForTask: jest.fn().mockResolvedValue({ model: 'm', provider: 'anthropic' }),
  }),
}));

const complete = jest.fn();
jest.mock('../../llm/client', () => ({ llmClient: { modelSelectionFor: (p: any) => (p?.model ? { provider: p.provider ?? 'anthropic', model: p.model } : (p?.provider ? { provider: p.provider } : {})), complete: (...a: unknown[]) => complete(...a) } }));

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
  getPoolForService: jest.fn().mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
}));

import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: { writableLayers: [], readableLayers: [] },
  traceId: 'trace-1',
};

const COLUMNS = [
  { index: 0, name: 'Condition', format: 'text', prompt: 'What must be delivered' },
  { index: 1, name: 'Deadline', format: 'date', prompt: 'By when' },
  { index: 2, name: 'Satisfied', format: 'yes_no', prompt: 'Is it satisfied' },
];

const call = (overrides: Record<string, unknown> = {}) =>
  executeStandardTool(
    'tabular_enumerate',
    {
      textContent: 'a credit agreement',
      filename: 'facility.pdf',
      rowDefinition: 'condition precedent',
      columns: COLUMNS,
      ...overrides,
    },
    ctx,
  );

const reply = (content: string) => complete.mockResolvedValue({ content });

beforeEach(() => jest.clearAllMocks());

describe('input contract', () => {
  it.each([
    ['textContent', { textContent: undefined }],
    ['columns', { columns: [] }],
    ['rowDefinition', { rowDefinition: undefined }],
  ])('rejects a call with no %s', async (_name, override) => {
    const r = await call(override);
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/textContent.*columns.*rowDefinition/i);
  });

  it('names the row unit in the prompt, since the columns do not imply it', async () => {
    reply('[]');
    await call();
    const prompt = complete.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('every condition precedent');
    expect(prompt).toContain('"Deadline"');
  });
});

describe('parsing what a model actually returns', () => {
  it('reads a bare JSON array', async () => {
    reply('[{"Condition":"Board approval","Deadline":"2026-01-15","Satisfied":"Yes"}]');
    const r = await call();
    expect(r?.success).toBe(true);
    expect(r?.result).toMatchObject({
      filename: 'facility.pdf',
      columns: ['Condition', 'Deadline', 'Satisfied'],
      rows: [['Board approval', '2026-01-15', 'Yes']],
      rowCount: 1,
    });
  });

  it('reads an array inside a markdown fence', async () => {
    reply('```json\n[{"Condition":"Legal opinion","Deadline":"none","Satisfied":"no"}]\n```');
    const r = await call();
    expect((r?.result as { rows: string[][] }).rows).toEqual([
      ['Legal opinion', 'Not specified', 'No'],
    ]);
  });

  it('reads an array wrapped in prose it was told not to add', async () => {
    reply('Here are the conditions:\n[{"Condition":"Fee paid"}]\nThat is all.');
    const r = await call();
    expect(r?.success).toBe(true);
    expect((r?.result as { rowCount: number }).rowCount).toBe(1);
  });

  it('fails rather than inventing a table when nothing parses', async () => {
    reply('I could not find any conditions precedent in this document.');
    const r = await call();
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/JSON array/i);
  });

  it('fails when the model call throws', async () => {
    complete.mockRejectedValue(new Error('upstream 503'));
    const r = await call();
    expect(r?.success).toBe(false);
    expect(r?.error).toMatch(/could not read the document/i);
  });
});

describe('the result is a rectangle', () => {
  it('fills a column the model omitted, so every row has every column', async () => {
    reply('[{"Condition":"Insurance certificate"}]');
    const r = await call();
    expect((r?.result as { rows: string[][] }).rows).toEqual([
      ['Insurance certificate', 'Not specified', expect.stringMatching(/Uncertain/)],
    ]);
  });

  it('orders cells by column index, not by the order the model wrote its keys', async () => {
    reply('[{"Satisfied":"Yes","Condition":"Signed guarantee","Deadline":"2026-03-01"}]');
    const r = await call();
    expect((r?.result as { rows: string[][] }).rows[0]).toEqual([
      'Signed guarantee',
      '2026-03-01',
      'Yes',
    ]);
  });

  it('drops a non-object entry rather than emitting a row of nothing', async () => {
    reply('[{"Condition":"Real"}, "stray string", null]');
    const r = await call();
    expect((r?.result as { rowCount: number }).rowCount).toBe(1);
  });

  it('returns an empty table for a document with none, and calls that success', async () => {
    reply('[]');
    const r = await call();
    expect(r?.success).toBe(true);
    expect(r?.result).toMatchObject({ rows: [], rowCount: 0 });
  });
});

describe('a runaway enumeration', () => {
  it('caps the table and says it was capped', async () => {
    reply(JSON.stringify(Array.from({ length: 250 }, (_, i) => ({ Condition: `c${i}` }))));
    const r = await call();
    expect(r?.result).toMatchObject({ rowCount: 200, truncated: true, truncatedAt: 200 });
  });

  it('says nothing about truncation when it did not truncate', async () => {
    reply(JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ Condition: `c${i}` }))));
    const r = await call();
    expect(r?.result).not.toHaveProperty('truncated');
  });
});
