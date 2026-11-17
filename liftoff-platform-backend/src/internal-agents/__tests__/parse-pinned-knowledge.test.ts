// Tests for parseAndFilterPinnedKnowledge — the save-time helper that walks
// [[knowledge:id:title]] markers, silently filters orphan pins, and returns
// the validated ID list to persist into pinned_knowledge_ids.

jest.mock('../../knowledge/repository', () => ({
  findByIds: jest.fn(),
}));

import * as knowledgeRepo from '../../knowledge/repository';
import { parseAndFilterPinnedKnowledge } from '../router';

const findByIdsMock = knowledgeRepo.findByIds as jest.Mock;

// Use real UUIDs throughout: parseAndFilterPinnedKnowledge filters non-UUID
// id slots BEFORE the findByIds round-trip (defense against
// "invalid input syntax for type uuid" from Postgres on garbage markers).
const K1 = '11111111-1111-4111-8111-111111111111';
const K2 = '22222222-2222-4222-8222-222222222222';
const K_COLON = '33333333-3333-4333-8333-333333333333';
const K_MISSING = '44444444-4444-4444-8444-444444444444';
const C1 = 'c1';
const C2 = 'c2';

beforeEach(() => jest.clearAllMocks());

describe('parseAndFilterPinnedKnowledge', () => {
  it('returns [] when no markers present', async () => {
    const out = await parseAndFilterPinnedKnowledge('tenant-1', new Set(), 'no marker here', null);
    expect(out).toEqual([]);
    expect(findByIdsMock).not.toHaveBeenCalled();
  });

  it('returns ID when marker present and connector bound', async () => {
    findByIdsMock.mockResolvedValueOnce([
      { id: K1, title: 'Article', sourceUrl: null, connectorId: C1 },
    ]);
    const out = await parseAndFilterPinnedKnowledge(
      'tenant-1',
      new Set([C1]),
      `See [[knowledge:${K1}:Article]]`,
      null,
    );
    expect(out).toEqual([K1]);
  });

  it('silently filters when connector not bound', async () => {
    findByIdsMock.mockResolvedValueOnce([
      { id: K1, title: 'Article', sourceUrl: null, connectorId: C1 },
    ]);
    const out = await parseAndFilterPinnedKnowledge(
      'tenant-1',
      new Set([C2]),
      `See [[knowledge:${K1}:Article]]`,
      null,
    );
    expect(out).toEqual([]);
  });

  it('allows manual (connectorId null) items regardless of bound connectors', async () => {
    findByIdsMock.mockResolvedValueOnce([
      { id: K1, title: 'Manual', sourceUrl: 'https://x', connectorId: null },
    ]);
    const out = await parseAndFilterPinnedKnowledge(
      'tenant-1',
      new Set(),
      `See [[knowledge:${K1}:Manual]]`,
      null,
    );
    expect(out).toEqual([K1]);
  });

  it('silently filters items deleted from knowledge_items', async () => {
    findByIdsMock.mockResolvedValueOnce([]);
    const out = await parseAndFilterPinnedKnowledge(
      'tenant-1',
      new Set([C1]),
      `See [[knowledge:${K_MISSING}:Missing]]`,
      null,
    );
    expect(out).toEqual([]);
    // The helper does query findByIds for valid-UUID ids; the result is just empty.
    expect(findByIdsMock).toHaveBeenCalledWith('tenant-1', [K_MISSING]);
  });

  it('extracts multiple markers and dedupes duplicates', async () => {
    findByIdsMock.mockResolvedValueOnce([
      { id: K1, title: 'A', sourceUrl: null, connectorId: C1 },
      { id: K2, title: 'B', sourceUrl: null, connectorId: C1 },
    ]);
    const out = await parseAndFilterPinnedKnowledge(
      'tenant-1',
      new Set([C1]),
      `See [[knowledge:${K1}:A]] and [[knowledge:${K2}:B]] and again [[knowledge:${K1}:A]]`,
      null,
    );
    expect(out).toEqual([K1, K2]);
  });

  it('handles colon in title (non-greedy match up to ]])', async () => {
    findByIdsMock.mockResolvedValueOnce([
      { id: K_COLON, title: 'RFC 1234: TCP/IP', sourceUrl: null, connectorId: null },
    ]);
    const out = await parseAndFilterPinnedKnowledge(
      'tenant-1',
      new Set(),
      `[[knowledge:${K_COLON}:RFC 1234: TCP/IP]]`,
      null,
    );
    expect(out).toEqual([K_COLON]);
  });

  it('ignores malformed marker missing title', async () => {
    const out = await parseAndFilterPinnedKnowledge(
      'tenant-1',
      new Set(),
      `malformed [[knowledge:${K1}]] here`,
      null,
    );
    expect(out).toEqual([]);
    expect(findByIdsMock).not.toHaveBeenCalled();
  });

  it('reads from multiple text fields (responsibilities + additionalContext)', async () => {
    findByIdsMock.mockResolvedValueOnce([
      { id: K1, title: 'A', sourceUrl: null, connectorId: C1 },
      { id: K2, title: 'B', sourceUrl: null, connectorId: C1 },
    ]);
    const out = await parseAndFilterPinnedKnowledge(
      'tenant-1',
      new Set([C1]),
      `[[knowledge:${K1}:A]]`,
      `[[knowledge:${K2}:B]]`,
    );
    expect(out.sort()).toEqual([K1, K2].sort());
  });

  it('silently filters non-UUID ids BEFORE the findByIds round-trip', async () => {
    // Operator-typed garbage in the id slot must NOT reach Postgres — the
    // pinned_knowledge_ids column is UUID[] and ANY($::uuid[]) on a bad
    // string throws "invalid input syntax for type uuid", breaking the
    // entire save with HTTP 500.
    const out = await parseAndFilterPinnedKnowledge(
      'tenant-1',
      new Set([C1]),
      'See [[knowledge:not-a-uuid:Bad]] and [[knowledge::Empty]]',
      null,
    );
    expect(out).toEqual([]);
    expect(findByIdsMock).not.toHaveBeenCalled();
  });

  it('keeps the valid UUID even when garbage markers are also present', async () => {
    findByIdsMock.mockResolvedValueOnce([
      { id: K1, title: 'OK', sourceUrl: null, connectorId: C1 },
    ]);
    const out = await parseAndFilterPinnedKnowledge(
      'tenant-1',
      new Set([C1]),
      `[[knowledge:not-a-uuid:Bad]] and [[knowledge:${K1}:OK]]`,
      null,
    );
    expect(out).toEqual([K1]);
    expect(findByIdsMock).toHaveBeenCalledWith('tenant-1', [K1]);
  });
});
