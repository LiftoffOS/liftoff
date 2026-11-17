/**
 * The runtime half of the window invariant.
 *
 * The sibling test stops the two constants drifting apart. This one covers the
 * other way in: a NEW caller passing its own wider window at the call site,
 * which no constant comparison would catch. The count it gets back would be low
 * by however many corrections retention had already deleted, and nothing about
 * the call would look wrong — the query succeeds and returns a number.
 *
 * So the query says so, loudly, and deliberately does NOT clamp: clamping would
 * answer a narrower question than the caller asked while appearing to comply.
 */
const queryMock = jest.fn();
const loggerErrorMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
  getPool: () => ({ query: (...args: unknown[]) => queryMock(...args) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: {
    error: (...args: unknown[]) => loggerErrorMock(...args),
    warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
  },
}));

import { ReflectionRepository, EVIDENCE_RECENCY_WINDOW_DAYS } from '../repository';
import { RETENTION_DAYS } from '../../agent-execution/escalation-retention';

const repo = new ReflectionRepository();

beforeEach(() => {
  queryMock.mockReset();
  loggerErrorMock.mockReset();
  queryMock.mockResolvedValue({
    rows: [{
      failures: '0', undos: '0', human_corrections: '0',
      policy_denials: '0', escalations: '0', successful_runs: '0',
    }],
  });
});

describe('recent evidence window guard', () => {
  it('stays quiet for the window the platform actually uses', async () => {
    await repo.getRecentEvidenceCounts('agent-1', EVIDENCE_RECENCY_WINDOW_DAYS);

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('stays quiet right up to the retention boundary', async () => {
    await repo.getRecentEvidenceCounts('agent-1', RETENTION_DAYS);

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('reports a window wider than retention, naming both numbers', async () => {
    await repo.getRecentEvidenceCounts('agent-1', RETENTION_DAYS + 1);

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock.mock.calls[0][0]).toMatchObject({
      metric: 'reflection.evidence_window_exceeds_retention',
      days: RETENTION_DAYS + 1,
      retentionDays: RETENTION_DAYS,
    });
  });

  it('still answers the question it was asked, unclamped', async () => {
    await repo.getRecentEvidenceCounts('agent-1', RETENTION_DAYS + 1);

    // The caller's window reaches the SQL untouched. Silently substituting a
    // narrower one would make the number look trustworthy while meaning
    // something else.
    expect(queryMock.mock.calls[0][1]).toEqual(['agent-1', RETENTION_DAYS + 1]);
  });
});
