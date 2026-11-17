/**
 * agentScheduledInvocationsRepo.releaseFailedClarificationResume
 *
 * Answering a clarification moves the row 'pending' -> 'resume_inflight'
 * without taking a lease. When the resume then failed, nothing could recover
 * it: `markErrored` matches 'pending' only and so did nothing, the stale-lease
 * reconciler skips rows whose `lease_until` is null, and the review queue
 * selects 'pending' alone. The ask sat in 'resume_inflight' forever — out of
 * the queue, never retried, never errored, and the person who answered was
 * never told their answer had not landed.
 *
 * Returning it to 'pending' is both halves of the fix: the Cloud Tasks retry
 * can re-claim it, and once those are exhausted the question is back in front
 * of a person.
 *
 * Bounded, though. 'pending' is also the status the chat-turn router reads as
 * "the next message on this thread is the answer to this", so an ask that can
 * never resume and is released forever would absorb every later message on the
 * thread and leave chat dead with no error anywhere.
 */
const queryMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => queryMock(...args) }),
}));

import {
  agentScheduledInvocationsRepo,
  CLARIFICATION_MAX_RESUME_ATTEMPTS,
} from '../agent-scheduled-invocations-repo';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('releaseFailedClarificationResume', () => {
  it('returns the row to pending so the queue can show it again', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'pending' }] });

    const outcome = await agentScheduledInvocationsRepo.releaseFailedClarificationResume(
      'sched-1', 'engine down',
    );

    expect(outcome).toEqual({ released: true, exhausted: false });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('last_error = $2');
    expect(params).toEqual(['sched-1', 'engine down', CLARIFICATION_MAX_RESUME_ATTEMPTS]);
  });

  it('only touches a row that is actually mid-resume', async () => {
    // Not 'errored' on the first failure: the handler answers 500 so Cloud
    // Tasks retries, and the resume accepts 'pending' or 'resume_inflight'.
    // Marking it errored immediately would make a transient fault permanent.
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'pending' }] });

    await agentScheduledInvocationsRepo.releaseFailedClarificationResume('sched-1', 'boom');

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("status = 'resume_inflight'");
    expect(sql).toContain("objective = 'clarification-expiry'");
  });

  // The cap is expressed in SQL so the read and the write cannot drift apart
  // under a concurrent retry.
  it('spends an attempt on every release and errors the ask once the budget is gone', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ status: 'errored' }] });

    const outcome = await agentScheduledInvocationsRepo.releaseFailedClarificationResume(
      'sched-1', 'agent not ACTIVE',
    );

    expect(outcome).toEqual({ released: false, exhausted: true });
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('resume_attempts = resume_attempts + 1');
    expect(sql).toContain("WHEN resume_attempts + 1 >= $3 THEN 'errored'");
  });

  it('reports nothing released when there was nothing mid-resume', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await expect(
      agentScheduledInvocationsRepo.releaseFailedClarificationResume('sched-1', 'boom'),
    ).resolves.toEqual({ released: false, exhausted: false });
  });

  it('does not crash when the driver returns no rows array', async () => {
    queryMock.mockResolvedValueOnce({});

    await expect(
      agentScheduledInvocationsRepo.releaseFailedClarificationResume('sched-1', 'boom'),
    ).resolves.toEqual({ released: false, exhausted: false });
  });
});
