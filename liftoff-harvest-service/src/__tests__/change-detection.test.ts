/* eslint-disable @typescript-eslint/no-var-requires */

const mockQuery = jest.fn();
jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockQuery })),
  closePool: jest.fn(),
}));

jest.mock('../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  computeContentHash,
  lookupEntity,
  upsertEntity,
  needsTtlRefresh,
} from '../change-detection';
import type { EntityRecord } from '../change-detection';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('computeContentHash', () => {
  it('returns the same hash for the same input', () => {
    const h1 = computeContentHash('hello world');
    const h2 = computeContentHash('hello world');
    expect(h1).toBe(h2);
  });

  it('returns different hashes for different inputs', () => {
    const h1 = computeContentHash('hello world');
    const h2 = computeContentHash('hello world!');
    expect(h1).not.toBe(h2);
  });
});

describe('lookupEntity', () => {
  it('returns null when query returns no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await lookupEntity('conn-1', 'entity-1');
    expect(result).toBeNull();
  });

  it('returns mapped EntityRecord for known entity', async () => {
    const expiresAt = new Date('2026-12-31T00:00:00.000Z');
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          content_hash: 'abc123',
          memory_id: 'mem-1',
          memory_type: 'CONVENTION',
          expires_at: expiresAt,
        },
      ],
    });
    const result = await lookupEntity('conn-1', 'entity-1');
    expect(result).toEqual({
      contentHash: 'abc123',
      memoryId: 'mem-1',
      memoryType: 'CONVENTION',
      expiresAt,
    });
  });
});

describe('upsertEntity', () => {
  it('calls INSERT query with correct 6 params', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await upsertEntity({
      connectorId: 'conn-1',
      entityId: 'entity-1',
      contentHash: 'hash-abc',
      memoryId: 'mem-1',
      memoryType: 'CONVENTION',
      expiresAt: new Date('2026-12-31'),
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO harvest_entities');
    expect(params).toHaveLength(6);
    expect(params[0]).toBe('conn-1');
    expect(params[1]).toBe('entity-1');
    expect(params[2]).toBe('hash-abc');
    expect(params[3]).toBe('mem-1');
  });

  it('preserves existing memoryId when new value is null (COALESCE in SQL)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await upsertEntity({
      connectorId: 'conn-1',
      entityId: 'entity-1',
      contentHash: 'hash-xyz',
      memoryId: null,
      memoryType: null,
      expiresAt: null,
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('COALESCE');
    // memoryId param should be null
    expect(params[3]).toBeNull();
  });
});

describe('needsTtlRefresh', () => {
  it('returns false when expiresAt is null', () => {
    const record: EntityRecord = {
      contentHash: 'abc',
      memoryId: 'mem-1',
      memoryType: 'CONVENTION',
      expiresAt: null,
    };
    expect(needsTtlRefresh(record)).toBe(false);
  });

  it('returns false when far from expiry (300 days out, GOTCHA 365-day TTL)', () => {
    // TTL = 365, threshold = 365/2 = 182 days before expiry
    // expiresAt = 300 days from now → threshold was 300-182=118 days from now (future) → not past threshold
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 300);
    const record: EntityRecord = {
      contentHash: 'abc',
      memoryId: 'mem-1',
      memoryType: 'GOTCHA',
      expiresAt,
    };
    expect(needsTtlRefresh(record)).toBe(false);
  });

  it('returns true when past halfway point (10 days remaining, CONVENTION 180-day TTL)', () => {
    // TTL = 180, threshold = 90 days before expiry
    // expiresAt = 10 days from now → threshold was 90-10=80 days ago (past) → refresh needed
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 10);
    const record: EntityRecord = {
      contentHash: 'abc',
      memoryId: 'mem-1',
      memoryType: 'CONVENTION',
      expiresAt,
    };
    expect(needsTtlRefresh(record)).toBe(true);
  });
});
