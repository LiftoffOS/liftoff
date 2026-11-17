import { updateUsefulnessScores, checkPastColdStart } from '../usefulness-tracker';

// Mock database
const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('usefulness-tracker', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('updateUsefulnessScores', () => {
    it('uses atomic conditional UPDATE with 24h rate limit in WHERE clause', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'mem-1', usefulness_score: 2 }] });
      await updateUsefulnessScores(['mem-1'], 1, 90);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('usefulness_last_updated');
      expect(sql).toContain('INTERVAL');
      expect(sql).toContain('RETURNING');
    });

    it('returns IDs that were actually updated (rate-limited ones excluded)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'mem-1', usefulness_score: 2 }] });
      const updated = await updateUsefulnessScores(['mem-1', 'mem-2'], 1, 90);
      expect(updated).toEqual(['mem-1']); // mem-2 was rate-limited (not in RETURNING)
    });

    it('auto-supersedes at usefulness_score <= -3', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'mem-1', usefulness_score: -3 }] }) // UPDATE RETURNING
        .mockResolvedValueOnce({ rows: [] }); // supersede UPDATE

      await updateUsefulnessScores(['mem-1'], -1, 90);

      expect(mockQuery).toHaveBeenCalledTimes(2);
      const supersedeSql = mockQuery.mock.calls[1][0] as string;
      expect(supersedeSql).toContain('superseded_by');
      expect(supersedeSql).toContain('negative-usefulness');
    });

    it('does NOT auto-supersede at usefulness_score = -2', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'mem-1', usefulness_score: -2 }] });
      await updateUsefulnessScores(['mem-1'], -1, 90);
      expect(mockQuery).toHaveBeenCalledTimes(1); // no supersede call
    });

    it('renews TTL on success (+1 delta)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'mem-1', usefulness_score: 1 }] });
      await updateUsefulnessScores(['mem-1'], 1, 90);

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('expires_at');
      expect(sql).toContain('CASE WHEN $1 > 0');
    });

    it('does NOT renew TTL on failure (-1 delta)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'mem-1', usefulness_score: -1 }] });
      await updateUsefulnessScores(['mem-1'], -1, 90);

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('ELSE expires_at END');
    });

    it('returns empty array for empty input', async () => {
      const result = await updateUsefulnessScores([], 1, 90);
      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('checkPastColdStart', () => {
    it('returns false when agent has <= 5 executions', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [1, 2, 3, 4, 5], rowCount: 5 });
      const result = await checkPastColdStart('tenant-1', 'agent-1');
      expect(result).toBe(false);
    });

    it('returns true when agent has > 5 executions', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [1, 2, 3, 4, 5, 6], rowCount: 6 });
      const result = await checkPastColdStart('tenant-1', 'agent-1');
      expect(result).toBe(true);
    });

    it('uses LIMIT 6 (not COUNT *) for performance', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await checkPastColdStart('tenant-1', 'agent-1');

      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('LIMIT');
      expect(sql).not.toContain('COUNT');
    });
  });
});
