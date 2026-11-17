// Each agent's Learned Context: read through the page's own client call,
// walked to the end under the budget, cut off at asOf, and written as the
// page renders it.

const listAgentMemories = jest.fn();
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    listAgentMemories: (...a: unknown[]) => listAgentMemories(...a),
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ExportBudget, ExportSourceUnavailableError, ExportTooLargeError } from '../budget';
import { collectLearnedContext, formatMemoryContent, prettifyToolNames, projectLearnedContext } from '../learned-context';
import type { TeamRow } from '../queries';

const AS_OF = new Date('2026-09-18T21:04:11.318Z');
const team = (id: string): TeamRow => ({
  id, sort_cursor: 'x', role: 'Team', summary: null, responsibilities: null, additional_context: null,
  integrations: [], status: 'active', created_at: new Date('2026-08-01T00:00:00Z'),
});
const memory = (id: string, createdAt: string, content = `memory ${id}`) => ({ id, content, source: 'learned', createdAt });

beforeEach(() => {
  listAgentMemories.mockReset();
});

describe('collectLearnedContext', () => {
  it('asks the runtime for each team by the internal agent id the page\'s route uses, walks every page, and keeps what was learned by asOf', async () => {
    listAgentMemories
      .mockResolvedValueOnce({ memories: [memory('m-3', '2026-09-19T00:00:00.000Z'), memory('m-2', '2026-09-10T00:00:00.000Z')], nextCursor: 'c1', total: 3 })
      .mockResolvedValueOnce({ memories: [memory('m-1', '2026-09-01T00:00:00.000Z')], nextCursor: null, total: 3 })
      .mockResolvedValueOnce({ memories: [], nextCursor: null, total: 0 });
    const budget = new ExportBudget();
    const out = await collectLearnedContext('tenant-1', [team('team-a'), team('team-b')], AS_OF, budget);

    expect(listAgentMemories.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['tenant-1', 'team-a', { limit: 200, cursor: undefined }],
      ['tenant-1', 'team-a', { limit: 200, cursor: 'c1' }],
      ['tenant-1', 'team-b', { limit: 200, cursor: undefined }],
    ]);
    expect(out.get('team-a')?.map((m) => m.id)).toEqual(['m-2', 'm-1']);
    expect(out.get('team-b')).toEqual([]);
    // Two rows charged; the one after asOf never was.
    expect(budget.recordsLeft).toBe(100_000 - 2);
  });

  it('names the runtime as the 503 when a team\'s memories cannot be read', async () => {
    listAgentMemories.mockRejectedValueOnce(new Error('HTTP 502 from tenant runtime memories/list'));
    await expect(collectLearnedContext('tenant-1', [team('team-a')], AS_OF, new ExportBudget()))
      .rejects.toBeInstanceOf(ExportSourceUnavailableError);
    await expect(collectLearnedContext('tenant-1', [team('team-a')], AS_OF, new ExportBudget()))
      .rejects.toMatchObject({ source: 'tenant_runtime' });
  });

  it('stops at the ceiling like every other section', async () => {
    listAgentMemories.mockResolvedValue({ memories: [memory('m-1', '2026-09-01T00:00:00.000Z'), memory('m-2', '2026-09-02T00:00:00.000Z')], nextCursor: null, total: 2 });
    await expect(collectLearnedContext('tenant-1', [team('team-a')], AS_OF, new ExportBudget(1)))
      .rejects.toBeInstanceOf(ExportTooLargeError);
  });

  it('asks for nothing when the workspace has no teams', async () => {
    const out = await collectLearnedContext('tenant-1', [], AS_OF, new ExportBudget());
    expect(out.size).toBe(0);
    expect(listAgentMemories).not.toHaveBeenCalled();
  });
});

describe('formatMemoryContent (the page\'s own normalisation, ported)', () => {
  it('strips MCP tool ids, markdown bold, line breaks and doubled spaces exactly as src/utils/formatMemoryContent.ts does', () => {
    expect(prettifyToolNames('Use mcp__github-eaec0c30__get_pr then mcp__slack__send')).toBe('Use get_pr then send');
    expect(formatMemoryContent('**Rule:** Never merge on Fridays.\n**Why:**   The deploy window is Monday.\n**Applies when:** Merging'))
      .toBe('Rule: Never merge on Fridays. · Why: The deploy window is Monday. · Applies when: Merging');
    expect(formatMemoryContent('  plain   text \t here  ')).toBe('plain text here');
  });
});

describe('projectLearnedContext', () => {
  it('writes the text and when it was learned, oldest first, and nothing else', () => {
    expect(projectLearnedContext([
      { id: 'm-2', content: '**Second**', createdAt: '2026-09-10T10:00:00.000Z' },
      { id: 'm-1', content: 'First', createdAt: '2026-09-09T10:00:00.000Z' },
    ])).toEqual([
      { Context: 'First', Learned: '2026-09-09T10:00:00.000Z' },
      { Context: 'Second', Learned: '2026-09-10T10:00:00.000Z' },
    ]);
    expect(projectLearnedContext([])).toEqual([]);
  });
});
