// Tests for the embedding-dim cascade verifier. Uses a mocked pool so
// we control what pg_attribute returns and can assert each failure mode.
//
// The column is vector(768), not halfvec(3072), because Vertex's API caps
// outputDimensionality at 768. See migration 263.

import { jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));
jest.mock('../embedding', () => ({ ACTIVE_DIM: 768 }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { verifyEmbeddingDimCascade } from '../dim-bind-verifier';

beforeEach(() => mockQuery.mockReset());

const vector768 = { typname: 'vector', atttypmod: 768 };

it('passes when every table has vector(768)', async () => {
  mockQuery.mockResolvedValue({ rows: [vector768] });
  await expect(verifyEmbeddingDimCascade()).resolves.toBeUndefined();
});

it('throws when any table is still halfvec', async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ typname: 'halfvec', atttypmod: 768 }] })  // memories
    .mockResolvedValueOnce({ rows: [vector768] })
    .mockResolvedValueOnce({ rows: [vector768] });
  await expect(verifyEmbeddingDimCascade()).rejects.toThrow(/memories.*type=halfvec/);
});

it('throws when any table has wrong dim', async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [vector768] })
    .mockResolvedValueOnce({ rows: [{ typname: 'vector', atttypmod: 1536 }] })  // agent_skills wrong
    .mockResolvedValueOnce({ rows: [vector768] });
  await expect(verifyEmbeddingDimCascade()).rejects.toThrow(/agent_skills.*dim=1536/);
});

it('throws when a table has no embedding column', async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  await expect(verifyEmbeddingDimCascade()).rejects.toThrow(/no 'embedding' column/);
});

it('reports every mismatch in one error', async () => {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ typname: 'halfvec', atttypmod: 3072 }] })
    .mockResolvedValueOnce({ rows: [{ typname: 'halfvec', atttypmod: 3072 }] })
    .mockResolvedValueOnce({ rows: [{ typname: 'halfvec', atttypmod: 3072 }] });
  await expect(verifyEmbeddingDimCascade()).rejects.toThrow(/memories.*agent_skills.*connector_content/s);
});
