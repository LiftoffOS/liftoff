// Not sending to somewhere confirmed dead.
//
// The fan-out has always recorded who it could not reach. Nothing read it back,
// so the same deactivated account was retried on every notification, burning
// flood-control budget on a message that cannot arrive.
//
// The risk in the other direction is the one that matters: latch too eagerly
// and a real person silently stops receiving anything. So the threshold takes
// several failures, and any success un-latches immediately.

import { DEAD_TARGET_THRESHOLD, getDeadTargets, partitionLiveTargets } from '../dead-targets';

const query = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: unknown) => unknown) => fn({ query: (...a: unknown[]) => query(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TENANT = '00000000-0000-0000-0000-0000000000aa';

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('the threshold', () => {
  it('takes more than one failure', () => {
    // One failure is a blip — a transient Slack error, a token mid-refresh —
    // and latching on it would silence someone over a bad minute.
    expect(DEAD_TARGET_THRESHOLD).toBeGreaterThan(1);
  });
});

describe('getDeadTargets', () => {
  it('asks only for targets that are currently failing and past the threshold', async () => {
    await getDeadTargets(TENANT, 'review', 'slack');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/delivered = false/);
    expect(sql).toMatch(/consecutive_failures >= \$3/);
    expect(params).toContain(DEAD_TARGET_THRESHOLD);
  });

  it('scopes to the delivery kind', async () => {
    await getDeadTargets(TENANT, 'draft', 'slack');
    expect(query.mock.calls[0][1]).toContain('draft');
  });

  it('fails open — an unreadable table sends to everyone', async () => {
    // A wasted send is recoverable. A notification suppressed by a database
    // error is not.
    query.mockRejectedValue(new Error('db down'));
    await expect(getDeadTargets(TENANT, 'review', 'slack')).resolves.toEqual(new Set());
  });
});

describe('partitionLiveTargets', () => {
  it('splits the dead from the live', async () => {
    query.mockResolvedValue({ rows: [{ assignee_account_id: 'b' }], rowCount: 1 });
    const r = await partitionLiveTargets(TENANT, 'review', ['a', 'b', 'c'], 'slack');
    expect(r.live).toEqual(['a', 'c']);
    expect(r.skipped).toEqual(['b']);
  });

  it('passes everyone through when nothing is latched', async () => {
    const r = await partitionLiveTargets(TENANT, 'review', ['a', 'b'], 'slack');
    expect(r.live).toEqual(['a', 'b']);
    expect(r.skipped).toEqual([]);
  });

  it('does not query at all for an empty recipient list', async () => {
    const r = await partitionLiveTargets(TENANT, 'review', [], 'slack');
    expect(r).toEqual({ live: [], skipped: [] });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('the fan-out wiring', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'slack-adapter', 'review-dm-notifier.ts'),
    'utf8',
  ) as string;

  it('filters both fan-outs, not just one', () => {
    const uses = src.match(/partitionLiveTargets\(/g) ?? [];
    expect(uses.length).toBe(2);
  });

  it('records only what it actually attempted', () => {
    // Counting a skipped target as another failure would deepen a latch
    // nothing tested — the count would climb forever on its own, and the
    // target could never recover even if it came back.
    expect(src).toMatch(/attemptedUnreachable/);
    expect(src).not.toMatch(/recordDmFanoutOutcome\([\s\S]{0,200}\.\.\.skipped/);
  });

  it('still reports skipped targets to the caller, so the totals add up', () => {
    expect(src).toMatch(/\.\.\.attemptedUnreachable, \.\.\.skipped/);
    expect(src).toMatch(/reportedUnreachable/);
  });
});

describe('every channel, not just Slack', () => {
  const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8') as string;

  it('keys a target by channel as well as person', async () => {
    // The same person can be reachable on Slack and dead on Teams. Collapsing
    // those would let one channel's failures silence the other.
    await getDeadTargets(TENANT, 'review', 'teams');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/AND channel = \$4/);
    expect(params).toContain('teams');
  });

  it('reads the generalised table, not the Slack-only one', async () => {
    await getDeadTargets(TENANT, 'review', 'slack');
    expect(query.mock.calls[0][0]).toMatch(/FROM dm_delivery_attempts/);
  });

  it('filters the Teams review fan-out too', () => {
    // Teams computed an unreachable list from the start and discarded it, so
    // the same person was retried on every review, forever.
    const src = read('teams-adapter/review-card-notifier.ts');
    expect(src).toMatch(/partitionLiveTargets\(\s*\n?\s*tenantId, 'review', assigneeAccountIds, 'teams',/);
  });

  it('records the Teams outcome, so the registry has an input at all', () => {
    const src = read('teams-adapter/review-card-notifier.ts');
    expect(src).toMatch(/recordFanoutOutcome\(\{/);
    expect(src).toMatch(/channel: 'teams'/);
  });

  it('records only what Teams actually attempted', () => {
    // Counting a skipped target as another failure deepens the latch every
    // round, so a target that came back could never recover.
    const src = read('teams-adapter/review-card-notifier.ts');
    expect(src).toMatch(/attemptedUnreachable/);
    expect(src).toMatch(/unreachableAccountIds: attemptedUnreachable/);
  });

  it('still reports skipped targets to the caller, so the totals add up', () => {
    const src = read('teams-adapter/review-card-notifier.ts');
    expect(src).toMatch(/\[\.\.\.attemptedUnreachable, \.\.\.skipped\]/);
  });

  it('shares ONE recorder between the channels', () => {
    // Two copies would drift on how a failure is counted, and a threshold means
    // nothing if the write side and the read side disagree.
    expect(read('dead-targets.ts')).toMatch(/export async function recordFanoutOutcome/);
    expect(read('slack-adapter/review-dm-notifier.ts')).toMatch(/recordFanoutOutcome\(\{/);
  });
});
