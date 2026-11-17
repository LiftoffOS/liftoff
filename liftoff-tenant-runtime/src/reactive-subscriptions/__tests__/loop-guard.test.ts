// Loop-guard unit tests (C3).
//
// stateSignature is pure — a real state change (new commit, state flip, label edit) MUST
// flip the signature; a repeat of the same state MUST keep it stable; and no component may
// stringify to the literal "undefined" (which would make two different empty states collide
// or a missing field poison the hash). checkLoopGuard is a COUNT-and-cap over the fire ledger:
// same-signature repeats past MAX_NOPROGRESS ⇒ 'no_progress'; total-24h fires past MAX_FIRES ⇒
// 'runaway'; a legitimate multi-round cycle with DISTINCT signatures never trips.

const mockQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_tenantId: string, fn: (c: { query: typeof mockQuery }) => unknown) =>
    fn({ query: mockQuery }),
}));

import { stateSignature, checkLoopGuard, recordFire } from '../loop-guard';
import type { SubscriptionRow } from '../repository';

// Defaults from loop-guard.ts (no LOOP_GUARD_* env overrides in CI).
const MAX_NOPROGRESS = 5;
const MAX_FIRES = 50;

const sub = { id: 'sub-1', tenantId: 'tenant-1' } as unknown as SubscriptionRow;

beforeEach(() => {
  jest.clearAllMocks();
});

const HEX64 = /^[0-9a-f]{64}$/;

describe('stateSignature', () => {
  describe('PullRequest', () => {
    const base = {
      pull_request: {
        head: { sha: 'aaa111' },
        state: 'open',
        mergeable_state: 'clean',
        labels: [{ name: 'bug' }, { name: 'p1' }],
        title: 'Fix the widget',
        body: 'It is broken',
      },
    };

    it('is a stable 64-hex hash for identical state', () => {
      const a = stateSignature('PullRequest', base, []);
      const b = stateSignature('PullRequest', JSON.parse(JSON.stringify(base)), []);
      expect(a).toMatch(HEX64);
      expect(a).toBe(b);
    });

    it('flips when a new commit lands (head.sha change = real progress)', () => {
      const next = { pull_request: { ...base.pull_request, head: { sha: 'bbb222' } } };
      expect(stateSignature('PullRequest', next, [])).not.toBe(stateSignature('PullRequest', base, []));
    });

    it('flips on state, label, title, and body changes', () => {
      const sig = stateSignature('PullRequest', base, []);
      expect(stateSignature('PullRequest', { pull_request: { ...base.pull_request, state: 'closed' } }, [])).not.toBe(sig);
      expect(stateSignature('PullRequest', { pull_request: { ...base.pull_request, labels: [{ name: 'bug' }] } }, [])).not.toBe(sig);
      expect(stateSignature('PullRequest', { pull_request: { ...base.pull_request, title: 'Different' } }, [])).not.toBe(sig);
      expect(stateSignature('PullRequest', { pull_request: { ...base.pull_request, body: 'Different' } }, [])).not.toBe(sig);
    });

    it('is label-order-insensitive (reordering labels is not progress)', () => {
      const reordered = { pull_request: { ...base.pull_request, labels: [{ name: 'p1' }, { name: 'bug' }] } };
      expect(stateSignature('PullRequest', reordered, [])).toBe(stateSignature('PullRequest', base, []));
    });
  });

  describe('Issue', () => {
    const base = {
      issue: { state: 'open', assignees: [{ login: 'alice' }], labels: [{ name: 'bug' }], title: 'T', body: 'B' },
    };
    it('is stable and flips on state/assignee/label/title/body', () => {
      const sig = stateSignature('Issue', base, []);
      expect(sig).toMatch(HEX64);
      expect(stateSignature('Issue', base, [])).toBe(sig);
      expect(stateSignature('Issue', { issue: { ...base.issue, state: 'closed' } }, [])).not.toBe(sig);
      expect(stateSignature('Issue', { issue: { ...base.issue, assignees: [{ login: 'bob' }] } }, [])).not.toBe(sig);
      expect(stateSignature('Issue', { issue: { ...base.issue, labels: [{ name: 'wontfix' }] } }, [])).not.toBe(sig);
      expect(stateSignature('Issue', { issue: { ...base.issue, title: 'X' } }, [])).not.toBe(sig);
      expect(stateSignature('Issue', { issue: { ...base.issue, body: 'Y' } }, [])).not.toBe(sig);
    });
  });

  describe('PullRequestReview', () => {
    const base = {
      pull_request: { head: { sha: 'aaa' } },
      review: { id: 9, submitted_at: '2026-01-01T00:00:00Z', state: 'changes_requested', body: 'nit' },
    };
    it('is stable and flips on a new review id/state/body', () => {
      const sig = stateSignature('PullRequestReview', base, []);
      expect(sig).toMatch(HEX64);
      expect(stateSignature('PullRequestReview', base, [])).toBe(sig);
      expect(stateSignature('PullRequestReview', { ...base, review: { ...base.review, id: 10 } }, [])).not.toBe(sig);
      expect(stateSignature('PullRequestReview', { ...base, review: { ...base.review, state: 'approved' } }, [])).not.toBe(sig);
      expect(stateSignature('PullRequestReview', { ...base, review: { ...base.review, body: 'other' } }, [])).not.toBe(sig);
    });
  });

  describe('WorkflowRun', () => {
    const base = { workflow_run: { id: 5, conclusion: 'failure' } };
    it('is stable and flips when the conclusion changes', () => {
      const sig = stateSignature('WorkflowRun', base, []);
      expect(sig).toMatch(HEX64);
      expect(stateSignature('WorkflowRun', { workflow_run: { id: 5, conclusion: 'success' } }, [])).not.toBe(sig);
    });
  });

  describe('default (watchedPaths)', () => {
    it('hashes the watched paths and flips when a watched value changes', () => {
      const paths = ['status', 'nested.field'];
      const a = stateSignature('CustomThing', { status: 'a', nested: { field: 1 } }, paths);
      const b = stateSignature('CustomThing', { status: 'a', nested: { field: 2 } }, paths);
      expect(a).toMatch(HEX64);
      expect(a).not.toBe(b);
    });
  });

  it('never emits a literal "undefined" component: empty states hash deterministically', () => {
    // Two entirely-empty payloads must produce the SAME hash (str() maps undefined -> ''),
    // not collide-by-accident on the string "undefined".
    const a = stateSignature('PullRequest', {}, []);
    const b = stateSignature('PullRequest', {}, []);
    expect(a).toMatch(HEX64);
    expect(a).toBe(b);
    // A partially-populated PR differs from the empty one.
    expect(stateSignature('PullRequest', { pull_request: { state: 'open' } }, [])).not.toBe(a);
  });
});

describe('checkLoopGuard', () => {
  it('returns "no_progress" once same-signature fires reach MAX_NOPROGRESS in the window', async () => {
    mockQuery.mockResolvedValue({ rows: [{ same_sig: String(MAX_NOPROGRESS), all_24h: String(MAX_NOPROGRESS) }] });
    await expect(checkLoopGuard(sub, 'github:PullRequest:42', 'sig-x')).resolves.toBe('no_progress');
  });

  it('returns "runaway" once total 24h fires reach MAX_FIRES even with distinct signatures', async () => {
    // same_sig stays low (distinct sigs each round), but the raw 24h volume is a runaway.
    mockQuery.mockResolvedValue({ rows: [{ same_sig: '1', all_24h: String(MAX_FIRES) }] });
    await expect(checkLoopGuard(sub, 'github:PullRequest:42', 'sig-x')).resolves.toBe('runaway');
  });

  it('returns "ok" for a legitimate multi-round cycle: distinct sigs, volume under the backstop', async () => {
    // 4 real review rounds → each a distinct signature (same_sig=1), well under MAX_FIRES.
    mockQuery.mockResolvedValue({ rows: [{ same_sig: '1', all_24h: '4' }] });
    await expect(checkLoopGuard(sub, 'github:PullRequest:42', 'sig-round-4')).resolves.toBe('ok');
  });

  it('returns "ok" when the ledger is empty (first fire on a subject)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ same_sig: '0', all_24h: '0' }] });
    await expect(checkLoopGuard(sub, 'github:PullRequest:1', 'sig-1')).resolves.toBe('ok');
  });

  it('scopes the count query to this subscription + subject', async () => {
    mockQuery.mockResolvedValue({ rows: [{ same_sig: '0', all_24h: '0' }] });
    await checkLoopGuard(sub, 'github:PullRequest:7', 'sig-7');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM reactive_fire_ledger/);
    expect(params).toEqual(['sub-1', 'github:PullRequest:7', 'sig-7', expect.any(Number)]);
  });
});

describe('recordFire', () => {
  it('inserts one fire-ledger row scoped to the tenant/subscription/subject/signature', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await recordFire(sub, 'github:PullRequest:7', 'sig-7');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO reactive_fire_ledger/);
    expect(params).toEqual(['tenant-1', 'sub-1', 'github:PullRequest:7', 'sig-7']);
  });
});
