// Capability embedding text — unit tests.
//
// The embedding source used to read a `capabilities` column that has never
// existed on `internal_agents`, so the SELECT threw and no embedding was ever
// stored. `find_teammates` ran on its ILIKE fallback for the life of the
// feature without anything looking broken, because the caller is
// fire-and-forget by design.

import { buildEmbeddingText, AGENT_EMBEDDING_COLUMNS } from '../embedding-service';

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(),
  withTenantScope: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: { embed: jest.fn() },
}));

const BASE = {
  id: 'agent-1',
  tenantId: 'tenant-1',
  role: 'HR Agent',
  responsibilities: 'Manage employee records',
  summary: 'Handles HR tasks',
};

describe('buildEmbeddingText', () => {
  it('includes each skill name and description', () => {
    const text = buildEmbeddingText({
      ...BASE,
      skills: [
        { name: 'payroll', description: 'Run the payroll cycle', instruction: '...' },
        { name: 'benefits', description: 'Administer benefits', instruction: '...' },
      ],
    });

    expect(text).toContain('HR Agent');
    expect(text).toContain('Manage employee records');
    expect(text).toContain('payroll: Run the payroll cycle');
    expect(text).toContain('benefits: Administer benefits');
  });

  it('excludes archived skills', () => {
    const text = buildEmbeddingText({
      ...BASE,
      skills: [
        { name: 'payroll', description: 'Run the payroll cycle', instruction: '...' },
        { name: 'retired', description: 'no longer offered', instruction: '...', archived: true },
      ],
    });

    expect(text).toContain('payroll');
    expect(text).not.toContain('retired');
  });

  it('parses a skills column delivered as a JSON string', () => {
    // jsonb arrives parsed from pg, but the shared reader tolerates the string
    // form the same way the row mapper does.
    const text = buildEmbeddingText({
      ...BASE,
      skills: JSON.stringify([{ name: 'payroll', description: 'Run the payroll cycle', instruction: '...' }]),
    });

    expect(text).toContain('payroll: Run the payroll cycle');
  });

  it('still produces text for an agent with no skills', () => {
    const text = buildEmbeddingText({ ...BASE, skills: null });
    expect(text).toBe('HR Agent\nManage employee records\nHandles HR tasks');
  });

  it('does not read a capabilities column', () => {
    // The column does not exist; naming it is what made every embed throw.
    expect(AGENT_EMBEDDING_COLUMNS).not.toMatch(/\bcapabilities\b/);
    expect(AGENT_EMBEDDING_COLUMNS).toMatch(/\bskills\b/);
  });
});
