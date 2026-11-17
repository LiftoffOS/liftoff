// Change B: per-tenant 11h recompute guard.

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn();
  return {
    getPoolForService: jest.fn(() => ({ query })),
    __query: query,
  };
});

import { recomputeInfluenceScores } from '../influence-calculator';
import * as db from '../../infrastructure/database';

describe('recomputeInfluenceScores guard', () => {
  const query = (db as any).__query as jest.Mock;
  beforeEach(() => { query.mockReset(); });

  it('returns { skipped: true, updated: 0 } when guard atomically refuses to flip', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const result = await recomputeInfluenceScores('tenant-1');
    expect(result).toEqual({ skipped: true, updated: 0 });
  });
});
