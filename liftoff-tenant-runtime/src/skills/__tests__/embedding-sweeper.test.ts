// Tests for the agent_skills NULL-embedding sweeper.
//
// Pure unit tests with mocked DB pool and mocked generateEmbedding. The
// sweeper's contract: pick up to N rows, embed each, UPDATE the row.
// Per-row failures are logged + counted but never thrown.

import { jest } from '@jest/globals';

const queryMock = jest.fn();
const generateEmbeddingMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: queryMock }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../memory/embedding', () => ({
  generateEmbedding: generateEmbeddingMock,
  generateEmbeddingDetailed: jest.fn(async (text: string, opts: unknown) => {
    const embedding = await generateEmbeddingMock(text, opts);
    return { embedding, model: 'gemini-embedding-001', provider: 'google', dim: embedding?.length ?? 0 };
  }),
  getDefaultProvider: () => 'google',
  getProviderModel: () => 'gemini-embedding-001',
}));

import { sweepNullSkillEmbeddings } from '../embedding-sweeper';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

function row(id: string, description = 'guidance about something') {
  return {
    id,
    tenant_id: TENANT_ID,
    agent_id: '22222222-2222-2222-2222-222222222222',
    name: `skill-${id}`,
    description,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('sweepNullSkillEmbeddings', () => {
  it('embeds and updates every row when generateEmbedding succeeds', async () => {
    queryMock.mockImplementationOnce(() => Promise.resolve({ rows: [row('s1'), row('s2'), row('s3')] }));
    queryMock.mockImplementation(() => Promise.resolve({ rows: [] }));
    generateEmbeddingMock.mockImplementation(() => Promise.resolve([0.1, 0.2, 0.3]));

    const result = await sweepNullSkillEmbeddings(100);

    expect(result).toEqual({ attempted: 3, succeeded: 3, failed: 0, done: true });
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(3);
    // SELECT + 3 UPDATEs.
    expect(queryMock).toHaveBeenCalledTimes(4);
  });

  it('reports failed=N when generateEmbedding rejects on some rows (no throw)', async () => {
    queryMock.mockImplementationOnce(() => Promise.resolve({ rows: [row('a'), row('b'), row('c')] }));
    queryMock.mockImplementation(() => Promise.resolve({ rows: [] }));
    generateEmbeddingMock
      .mockImplementationOnce(() => Promise.resolve([0.1]))
      .mockImplementationOnce(() => Promise.reject(new Error('quota exceeded')))
      .mockImplementationOnce(() => Promise.resolve([0.3]));

    const result = await sweepNullSkillEmbeddings(100);

    expect(result).toEqual({ attempted: 3, succeeded: 2, failed: 1, done: true });
    // SELECT + 2 UPDATEs (the failure does not trigger an UPDATE).
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('returns done=false when SELECT returns exactly limit rows', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`r${i}`));
    queryMock.mockImplementationOnce(() => Promise.resolve({ rows }));
    queryMock.mockImplementation(() => Promise.resolve({ rows: [] }));
    generateEmbeddingMock.mockImplementation(() => Promise.resolve([0.5]));

    const result = await sweepNullSkillEmbeddings(5);

    expect(result.done).toBe(false);
    expect(result.attempted).toBe(5);
    expect(result.succeeded).toBe(5);
  });

  it('returns done=true when SELECT returns fewer rows than limit', async () => {
    queryMock.mockImplementationOnce(() => Promise.resolve({ rows: [row('only')] }));
    queryMock.mockImplementation(() => Promise.resolve({ rows: [] }));
    generateEmbeddingMock.mockImplementation(() => Promise.resolve([0.7]));

    const result = await sweepNullSkillEmbeddings(50);

    expect(result.done).toBe(true);
  });

  it('returns done=true and zero work when no NULL rows exist', async () => {
    queryMock.mockImplementationOnce(() => Promise.resolve({ rows: [] }));

    const result = await sweepNullSkillEmbeddings(100);

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0, done: true });
    expect(generateEmbeddingMock).not.toHaveBeenCalled();
  });

  it('UPDATE filter prevents overwriting a row whose embedding was filled by a racing writer', async () => {
    queryMock.mockImplementationOnce(() => Promise.resolve({ rows: [row('race')] }));
    queryMock.mockImplementation(() => Promise.resolve({ rows: [] }));
    generateEmbeddingMock.mockResolvedValue([0.9]);

    await sweepNullSkillEmbeddings(100);

    const updateCall = queryMock.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE agent_skills'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain('embedding IS NULL');
  });
});
