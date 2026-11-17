// The engine reads `groundsOn`, `toolDescriptionOverrides` and `resultRules`
// off `context.instruction`, and `context.instruction` is the compiled row's
// `instruction` JSONB — a column this runtime's compiler never writes. The
// columns it does write reach the engine only when the site that builds the
// context copies them, and the grounding floor read a field no site copied:
// declared on every hire, matched on no turn, on every path.
//
// Two halves: the copy does what it says, and every site that builds the
// instruction data performs it — a structural ratchet, because the fourth
// site is the one that gets missed.

import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('the compiled row\'s fields are carried onto the instruction data', () => {
  it('copies the rules, the overrides and the result policy, and defaults each on absence', async () => {
    const { AgentExecutionService } = await import('../service');
    const svc = Object.create(AgentExecutionService.prototype) as {
      carryInstructionFields: (data: Record<string, unknown>, instruction: Record<string, unknown>) => void;
    };
    const rule = { label: 'the help centre', terms: ['policy'], cues: ['what'], toolName: 'corpus_search', enabled: true };
    const data: Record<string, unknown> = { allowedConnectors: [] };
    svc.carryInstructionFields(data, {
      instructionsMd: '# md', learnedInstructionsMd: null, pinnedKnowledgeIds: ['k1'],
      groundsOn: [rule], toolDescriptionOverrides: { search: 'Search the corpus' }, resultRules: [{ toolName: 'search', requiresComplete: true }],
    });
    expect(data).toMatchObject({
      instructionsMd: '# md', learnedInstructionsMd: null, pinnedKnowledgeIds: ['k1'],
      groundsOn: [rule], toolDescriptionOverrides: { search: 'Search the corpus' }, resultRules: [{ toolName: 'search', requiresComplete: true }],
    });

    const bare: Record<string, unknown> = {};
    svc.carryInstructionFields(bare, {});
    expect(bare).toEqual({
      instructionsMd: null, learnedInstructionsMd: null, pinnedKnowledgeIds: [], groundsOn: [], toolDescriptionOverrides: {}, resultRules: [],
    });
  });
});

describe('every site that builds the instruction data carries the fields', () => {
  const source = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
  const lines = source.split('\n');
  const sites = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /const instructionData = \(instruction\.instruction \|\|/.test(line));

  it('finds the sites', () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it.each(sites.map((s) => [s.i + 1] as [number]))('line %d is followed by the carry', (lineNo) => {
    const window = lines.slice(lineNo - 1, lineNo + 14).join('\n');
    expect(window).toMatch(/this\.carryInstructionFields\(instructionData/);
  });
});
