// Change B: assert Laplace-smoothed influence_score derivation from rollup.
// The UPDATE clause uses (cited + 0.5) / (retrieved + 1.0) clamped to [0, 1].

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn();
  return {
    getPoolForService: jest.fn(() => ({ query })),
    __query: query,
  };
});

jest.mock('../metrics', () => ({
  observeHistogram: jest.fn(),
}));

import { recomputeInfluenceScores } from '../influence-calculator';
import * as db from '../../infrastructure/database';

describe('recomputeInfluenceScores', () => {
  const query = (db as any).__query as jest.Mock;
  beforeEach(() => { query.mockReset(); });

  it('skips when the 11h guard refuses the atomic UPDATE', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const result = await recomputeInfluenceScores('tenant-1');
    expect(result).toEqual({ skipped: true, updated: 0 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/UPDATE tenants[\s\S]+influence_last_recomputed/);
  });

  it('returns updated count when guard flips and emits per-layer influence_score histogram', async () => {
    const { observeHistogram } = require('../metrics');
    (observeHistogram as jest.Mock).mockReset();

    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ should_run: true }] });
    query.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        { id: 'm-1', influence_score: 0.83, layer: 'individual' },
        { id: 'm-2', influence_score: 0.22, layer: 'role' },
      ],
    });

    const result = await recomputeInfluenceScores('tenant-1');
    expect(result).toEqual({ skipped: false, updated: 2 });

    // Verify the SQL contains the Laplace-smoothed formula
    expect(query.mock.calls[1][0]).toMatch(/\(s\.cited \+ 0\.5\) \/ \(s\.retrieved \+ 1\.0\)/);

    // Verify histogram was observed for each updated memory, with layer label
    expect(observeHistogram).toHaveBeenCalledTimes(2);
    expect(observeHistogram).toHaveBeenCalledWith(
      // No tenant_id: a per-tenant label would key a new accumulator entry for
      // every tenant this loop ever sees, and it is never evicted.
      'influence_score', 0.83, expect.objectContaining({ layer: 'individual' }),
    );
    expect(observeHistogram).toHaveBeenCalledWith(
      'influence_score', 0.22, expect.objectContaining({ layer: 'role' }),
    );
  });
});
