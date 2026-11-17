// Change B: rollupYesterday aggregates retrieved_ids/cited_ids into the daily rollup.

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn();
  return {
    getPoolForService: jest.fn(() => ({ query })),
    __query: query,
  };
});

import { rollupYesterday } from '../influence-calculator';
import * as db from '../../infrastructure/database';

describe('rollupYesterday', () => {
  const query = (db as any).__query as jest.Mock;
  beforeEach(() => { query.mockReset(); });

  it('executes an UPSERT into memory_influence_rollup and returns the rowCount', async () => {
    query.mockResolvedValueOnce({ rowCount: 17, rows: [] });
    const count = await rollupYesterday('tenant-1');
    expect(count).toBe(17);

    const sql = query.mock.calls[0][0] as string;
    // Idempotent UPSERT
    expect(sql).toMatch(/INSERT INTO memory_influence_rollup/);
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, memory_id, day\) DO UPDATE/);
    // Window: only yesterday (CURRENT_DATE - INTERVAL '1 day' .. CURRENT_DATE)
    expect(sql).toMatch(/created_at >= CURRENT_DATE - INTERVAL '1 day'/);
    expect(sql).toMatch(/created_at < CURRENT_DATE/);
    // Cited flag derived from set intersection
    expect(sql).toMatch(/= ANY\(cited_ids\)/);
  });
});
