import { jest } from '@jest/globals';

jest.mock('../../infrastructure/logging', () => ({
  log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

beforeEach(() => {
  jest.resetModules();
  mockFetch.mockReset();
  process.env.MEM_RERANKER_ENABLED = '1';
  process.env.MEM_RERANKER_URL = 'https://reranker.test/rerank';
});

afterEach(() => {
  delete process.env.MEM_RERANKER_ENABLED;
  delete process.env.MEM_RERANKER_URL;
});

const candidates = [
  { id: 'a', content: 'first' },
  { id: 'b', content: 'second' },
  { id: 'c', content: 'third' },
];

it('returns input unchanged when global env disabled', async () => {
  process.env.MEM_RERANKER_ENABLED = '0';
  const { maybeRerank } = require('../rerank');
  const r = await maybeRerank('q', candidates, { tenantEnabled: true, topN: 10 });
  expect(r).toEqual(candidates);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('returns input unchanged when tenant disabled', async () => {
  const { maybeRerank } = require('../rerank');
  const r = await maybeRerank('q', candidates, { tenantEnabled: false, topN: 10 });
  expect(r).toEqual(candidates);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('reorders by cross-encoder scores', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ scores: [0.1, 0.9, 0.5] }),
  });
  const { maybeRerank } = require('../rerank');
  const r = await maybeRerank('q', candidates, { tenantEnabled: true, topN: 10 });
  expect(r.map((c: any) => c.id)).toEqual(['b', 'c', 'a']);
});

it('falls back to RRF order on non-2xx', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 500 });
  const { maybeRerank } = require('../rerank');
  const r = await maybeRerank('q', candidates, { tenantEnabled: true, topN: 10 });
  expect(r).toEqual(candidates);
});

it('falls back on score-length mismatch', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ scores: [0.1] }),
  });
  const { maybeRerank } = require('../rerank');
  const r = await maybeRerank('q', candidates, { tenantEnabled: true, topN: 10 });
  expect(r).toEqual(candidates);
});

it('falls back when fetch rejects (timeout / abort)', async () => {
  mockFetch.mockRejectedValue(new Error('aborted'));
  const { maybeRerank } = require('../rerank');
  const r = await maybeRerank('q', candidates, { tenantEnabled: true, topN: 10 });
  expect(r).toEqual(candidates);
});

it('only reranks topN — tail preserved verbatim', async () => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ scores: [0.1, 0.9] }),
  });
  const { maybeRerank } = require('../rerank');
  const r = await maybeRerank('q', candidates, { tenantEnabled: true, topN: 2 });
  expect(r.map((c: any) => c.id)).toEqual(['b', 'a', 'c']);
});

it('returns input unchanged when fewer than 2 candidates', async () => {
  const { maybeRerank } = require('../rerank');
  const r = await maybeRerank('q', [{ id: 'a', content: 'x' }],
    { tenantEnabled: true, topN: 10 });
  expect(r).toEqual([{ id: 'a', content: 'x' }]);
});
