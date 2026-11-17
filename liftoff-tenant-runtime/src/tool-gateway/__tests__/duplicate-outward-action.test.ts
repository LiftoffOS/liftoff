// The same outward act, twice in one run.
//
// The properties that matter are the two failure directions. Over-blocking
// breaks the agent's actual job — a review that comments on ten lines must post
// ten comments. Under-blocking is the defect: two pull-request-level summaries
// in one run, separately worded, must not both land.

const mockQuery = jest.fn();

// ONE accessor, mocked once. This used to mock the bare `pool` export while
// `execute-batch.test.ts` mocked `getPool` — two surfaces, and each suite
// covered the one the other forgot. The gateway now reads through `getPool()`
// alone, so there is nothing left to half-mock.
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockQuery(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { findCompletedDuplicate, duplicateRefusal, duplicateReplay } from '../duplicate-outward-action';
import { deriveTarget } from '../../action-ledger/target-ref';

const base = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  traceId: 'trace-abc',
  actionType: 'add_comment',
};

const HIT = { rows: [{ id: 'action-1', created_at: '2026-08-26T17:38:10.000Z' }], rowCount: 1 };
const MISS = { rows: [], rowCount: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue(MISS);
});

describe('the target model separates an anchored comment from a PR-level one', () => {
  const pr = { owner: 'acme', repo: 'web-app', pull_number: 81, head_sha: 'a450b99' };

  it('a PR-level post targets the pull request', () => {
    expect(deriveTarget({ connector: 'github', actionType: 'add_comment', payload: pr }).ref)
      .toBe('github:acme/web-app#81');
  });

  it('a line-anchored comment targets the line', () => {
    // This is what lets a loop post N comments without any of them colliding:
    // they genuinely act on different things.
    const a = deriveTarget({ connector: 'github', actionType: 'add_comment', payload: { ...pr, path: 'src/a.ts', line: 42 } });
    const b = deriveTarget({ connector: 'github', actionType: 'add_comment', payload: { ...pr, path: 'src/a.ts', line: 88 } });
    const c = deriveTarget({ connector: 'github', actionType: 'add_comment', payload: { ...pr, path: 'src/b.ts', line: 42 } });

    expect(a.ref).toBe('github:acme/web-app#81:src/a.ts:42');
    expect(new Set([a.ref, b.ref, c.ref]).size).toBe(3);
    // With a body, the finding is part of the anchor — see AN ANCHORED COMMENT
    // in target-ref.ts. Without one, the ref is the bare line, as above.
    const withBody = deriveTarget({
      connector: 'github', actionType: 'add_comment',
      payload: { ...pr, path: 'src/a.ts', line: 42, body: 'a finding' },
    });
    expect(withBody.ref).toMatch(/^github:acme\/web-app#81:src\/a\.ts:42@[0-9a-f]{12}$/);
    // The anchored comment is still ON the pull request, so it keeps the sha.
    expect(a.version).toBe('a450b99');
  });

  it('a file with no line still separates from the PR-level target', () => {
    expect(deriveTarget({ connector: 'github', actionType: 'add_comment', payload: { ...pr, path: 'src/a.ts' } }).ref)
      .toBe('github:acme/web-app#81:src/a.ts');
  });

  it('a review submission carrying its comments in an array stays PR-level', () => {
    // `create_review {comments: [{path, line}]}` acts on the pull request; the
    // anchors are inside the payload, not naming the target of the call.
    expect(deriveTarget({
      connector: 'github',
      actionType: 'create_and_submit_review',
      payload: { ...pr, comments: [{ path: 'src/a.ts', line: 42 }] },
    }).ref).toBe('github:acme/web-app#81');
  });
});

describe('findCompletedDuplicate', () => {
  const target = { ref: 'github:acme/web-app#81', version: 'a450b99', basis: 'connector_rule' as const };

  it('scopes the lookup to the run, the target and the version', () => {
    mockQuery.mockResolvedValue(MISS);
    return findCompletedDuplicate(base, target).then(() => {
      const [sql, params] = mockQuery.mock.calls[0];
      // The run is the invocation when the row names one, else the trace.
      expect(sql).toContain('invocation_id = $3::uuid');
      expect(sql).toContain('invocation_id IS NULL AND trace_id = $4');
      // A row written before act keys existed is matched by target and action.
      expect(sql).toContain('act_key IS NULL AND target_ref = $7 AND action_type = $8');
      // Equality never matches NULL, and NULL is the common version.
      expect(sql).toContain('target_version IS NOT DISTINCT FROM $9');
      expect(sql).toContain("status IN ('completed', 'succeeded')");
      // The multiplexed method rides in the key too — see ONE NAME OVER FIVE
      // OPERATIONS. Absent here, which is the common case.
      expect(sql).toContain("payload->>'method'");
      expect(params).toEqual([
        'tenant-1', 'agent-1', null, 'trace-abc', null, null, target.ref, 'add_comment', 'a450b99', null,
      ]);
    });
  });

  it('scopes to the invocation when the caller has one, and only a real uuid counts', async () => {
    mockQuery.mockResolvedValue(MISS);
    await findCompletedDuplicate({ ...base, invocationId: '6ebe2b95-0000-4000-8000-000000000001' }, target);
    expect(mockQuery.mock.calls[0][1][2]).toBe('6ebe2b95-0000-4000-8000-000000000001');
    await findCompletedDuplicate({ ...base, invocationId: 'not-a-uuid' }, target);
    expect(mockQuery.mock.calls[1][1][2]).toBeNull();
  });

  it('matches on the act key and every key that means the same act', async () => {
    mockQuery.mockResolvedValue(MISS);
    const mail = { ref: 'google-mail:to/a@x.com@0123456789ab', version: null, basis: 'connector_rule' as const };
    await findCompletedDuplicate(
      { ...base, actionType: 'send_email' }, mail, 'google-mail:send_email|to/a@x.com@0123456789ab',
    );
    const params = mockQuery.mock.calls[0][1];
    expect(params[4]).toEqual(expect.arrayContaining([
      'google-mail:send_email|to/a@x.com@0123456789ab',
      'microsoft-outlook-mail:send_email|to/a@x.com@0123456789ab',
    ]));
    // A capability that sent this email is matched by family and path: the
    // vendor behind it is unknown here, and only a mail_send counts.
    expect(params[5]).toBe('cap:mail_send:%|to/a@x.com@0123456789ab');
  });

  it('keys on the multiplexed method, so create and submit are not one act', async () => {
    mockQuery.mockResolvedValue(MISS);
    await findCompletedDuplicate({ ...base, payload: { ...base.payload, method: 'Submit_Pending' } }, target);
    // Normalised, so `Create` and `create` are one operation and a stored
    // lower-case value matches what the guard asks for.
    expect(mockQuery.mock.calls[0][1][9]).toBe('submit_pending');
  });

  it('reports a completed twin', async () => {
    mockQuery.mockResolvedValue(HIT);
    await expect(findCompletedDuplicate(base, target)).resolves.toMatchObject({ actionId: 'action-1' });
  });

  it('says nothing when the payload named no target', async () => {
    // Collapsing every unkeyed action in a run onto one another would block
    // unrelated work.
    await expect(findCompletedDuplicate(base, { ref: '', version: null, basis: 'none' })).resolves.toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('truncates the trace id the way the ledger stores it', async () => {
    // Stored via substring(0,128). A longer id queried in full matches nothing
    // and the guard is silently inert.
    await findCompletedDuplicate({ ...base, traceId: 'x'.repeat(200) }, target);
    expect(mockQuery.mock.calls[0][1][3]).toHaveLength(128);
  });

  it('FAILS OPEN when the lookup errors', async () => {
    // Blocking real work because a diagnostic read failed is worse than the
    // duplicate it prevents.
    mockQuery.mockRejectedValue(new Error('database is down'));
    await expect(findCompletedDuplicate(base, target)).resolves.toBeNull();
  });
});

describe('duplicateReplay — the answer for a duplicate that CAN be answered', () => {
  const target = { ref: 'github:acme/web-app#81', version: null, basis: 'connector_rule' as const };

  it('succeeds with the first call\'s recorded response', () => {
    // A graph step whose postcondition is already satisfied must not take its
    // onFailure branch. Refusing it routed workflows somewhere else.
    const r = duplicateReplay(base, target, {
      actionId: 'action-1',
      createdAt: '2026-08-28T05:54:29Z',
      externalResponse: { review_id: 42 },
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ review_id: 42 });
  });

  it('is not a stub success — it never invents data it does not have', () => {
    const r = duplicateReplay(base, target, { actionId: 'a', createdAt: 'b' });
    expect(r.data).toBeNull();
  });

  it('still tells the model it repeated itself', () => {
    const r = duplicateReplay(base, target, {
      actionId: 'a', createdAt: 'b', externalResponse: {},
    });
    expect(r.notice).toContain('Already done in this run');
    expect(r.notice).toContain('nothing was sent a second time');
    expect(r.error).toBeUndefined();
  });
});

describe('duplicateRefusal', () => {
  const target = { ref: 'github:acme/web-app#81', version: 'a450b99', basis: 'connector_rule' as const };
  const hit = { actionId: 'action-1', createdAt: '2026-08-26T17:38:10.000Z' };

  it('refuses rather than fabricating a success', () => {
    // A suppressed action reported as success is a stub success, which an
    // explicit platform invariant forbids.
    const r = duplicateRefusal(base, target, hit);
    expect(r.success).toBe(false);
    expect(r.data).toBeNull();
  });

  it('leads with a notice naming the target and the version', () => {
    const r = duplicateRefusal(base, target, hit);
    expect(r.notice).toBeTruthy();
    expect(r.notice).toBe(r.error);
    expect(r.notice).toContain('github:acme/web-app#81');
    expect(r.notice).toContain('a450b99');
    expect(r.notice).toContain('add_comment');
  });

  it('is not retryable — repeating it is the thing being refused', () => {
    expect(duplicateRefusal(base, target, hit).retryable).toBe(false);
  });
});
