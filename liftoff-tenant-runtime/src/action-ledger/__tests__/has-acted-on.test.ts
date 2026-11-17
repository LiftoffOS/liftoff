// "Have I already acted on this?" — and the three ways a boolean gets it wrong.
//
// A code-review agent can post a dozen "review ready" messages about one pull
// request in a morning and produce exactly one real review, when its step asks
// a question nothing can answer: select the oldest PR carrying no review FROM
// THIS AGENT at its current head sha.
//
// A two-valued answer cannot serve that question. Asked "have I reviewed #17 at
// sha a450b99" against a ledger row that recorded the review with no sha,
// `true` claims knowledge the ledger does not have and `false` sends the agent
// to redo work it already did. Both are confident and wrong, which is the
// same failure class as a connector reporting success on a 404, an actionable
// error classified internal_error, or an announcement fired for work that
// never landed.

const mockFind = jest.fn();

jest.mock('../repository', () => ({
  ActionRepository: jest.fn().mockImplementation(() => ({
    findPriorActionsOnTarget: (...a: unknown[]) => mockFind(...a),
  })),
  CompensationRepository: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ActionLedgerService } from '../service';

const row = (over: Partial<{ actionType: string; connector: string; targetVersion: string | null }> = {}) => ({
  actionType: 'create_review',
  connector: 'github-7d07a896',
  targetVersion: null,
  agentId: 'agent-1',
  createdAt: new Date('2026-08-24T10:00:00Z'),
  ...over,
});

const ask = (over: Record<string, unknown> = {}) =>
  new ActionLedgerService().hasActedOn({
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    targetRef: 'github:acme/billing#17',
    ...over,
  });

describe('hasActedOn — the four verdicts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('says no_record — not "not_acted" — when the ledger holds nothing', async () => {
    mockFind.mockResolvedValueOnce([]);
    expect((await ask()).verdict).toBe('no_record');
  });

  it('says acted when there is a record and no version was asked about', async () => {
    mockFind.mockResolvedValueOnce([row()]);
    expect((await ask()).verdict).toBe('acted');
  });

  it('says acted when a record names the exact version asked about', async () => {
    mockFind.mockResolvedValueOnce([row({ targetVersion: 'a450b99' })]);
    expect((await ask({ targetVersion: 'a450b99' })).verdict).toBe('acted');
  });

  // The PR moved on. The prior review is real but superseded, and the agent
  // SHOULD review again — this is the case an entity-only key gets wrong.
  it('says acted_at_other_version when every record names a different revision', async () => {
    mockFind.mockResolvedValueOnce([row({ targetVersion: 'older11' })]);
    expect((await ask({ targetVersion: 'a450b99' })).verdict).toBe('acted_at_other_version');
  });

  // The most important one. The work happened; whether it covers this revision
  // is unknown. Reporting "not_acted" here is what makes an agent redo work.
  it('says acted_version_unknown when the records name no revision at all', async () => {
    mockFind.mockResolvedValueOnce([row({ targetVersion: null })]);
    const answer = await ask({ targetVersion: 'a450b99' });
    expect(answer.verdict).toBe('acted_version_unknown');
    expect(answer.verdict).not.toBe('not_acted');
  });

  it('prefers an exact version match over a mixed history', async () => {
    mockFind.mockResolvedValueOnce([
      row({ targetVersion: 'older11' }),
      row({ targetVersion: 'a450b99' }),
      row({ targetVersion: null }),
    ]);
    expect((await ask({ targetVersion: 'a450b99' })).verdict).toBe('acted');
  });
});

describe('hasActedOn — what it queries', () => {
  beforeEach(() => jest.clearAllMocks());

  it('scopes to this agent by default', async () => {
    mockFind.mockResolvedValueOnce([]);
    await ask();
    expect(mockFind.mock.calls[0][0]).toMatchObject({ scope: 'agent', agentId: 'agent-1' });
  });

  it('widens to the tenant when asked, for work divided across a team', async () => {
    mockFind.mockResolvedValueOnce([]);
    await ask({ scope: 'tenant' });
    expect(mockFind.mock.calls[0][0]).toMatchObject({ scope: 'tenant' });
  });

  it('defaults to a 90-day window and reports the window it used', async () => {
    mockFind.mockResolvedValueOnce([]);
    const answer = await ask();
    expect(mockFind.mock.calls[0][0]).toMatchObject({ windowDays: 90 });
    // Reported back so the caller is never left inferring that "not_acted"
    // covers all of history. Nothing prunes this table today, so the bound is
    // the query's choice — which makes stating it more important, not less.
    expect(answer.windowDays).toBe(90);
  });

  it('caps an over-wide window rather than scanning without bound', async () => {
    mockFind.mockResolvedValueOnce([]);
    await ask({ windowDays: 99999 });
    expect(mockFind.mock.calls[0][0]).toMatchObject({ windowDays: 365 });
  });

  it('ignores a nonsensical window instead of querying with it', async () => {
    mockFind.mockResolvedValueOnce([]);
    await ask({ windowDays: -5 });
    expect(mockFind.mock.calls[0][0]).toMatchObject({ windowDays: 90 });
  });

  it('returns the prior actions so the agent can see what it did', async () => {
    mockFind.mockResolvedValueOnce([row({ actionType: 'create_review', targetVersion: 'a450b99' })]);
    const answer = await ask();
    expect(answer.actions).toEqual([{
      actionType: 'create_review',
      connector: 'github-7d07a896',
      version: 'a450b99',
      at: '2026-08-24T10:00:00.000Z',
    }]);
  });
});

// ── The blind spot is data, not prose ────────────────────────────────────────
//
// The ledger does not record sandbox work — `backstopLedger` exempts sandbox
// primitives — so an agent that posted a review with `gh pr review` asks this
// tool and hears the same word it would hear if nothing had happened. That is
// how six reviews posted in twelve hours against zero GitHub rows in `actions`.
//
// `not_acted` was a claim about the world the ledger cannot make. `no_record`
// is answerable from what it holds, and `unobserved` says what it could not see.
describe('every answer names what it could not see', () => {
  it('carries the sandbox blind spot when there is no record', async () => {
    mockFind.mockResolvedValue([]);
    const a = await ask();
    expect(a.verdict).toBe('no_record');
    expect(a.unobserved).toContain('sandbox_shell');
  });

  it('carries it on an AFFIRMATIVE answer too, where it means undercount', async () => {
    // The gap does not close when the answer is yes: the actions listed may be
    // fewer than the agent performed. A blind spot reported only on "no" is one
    // a reader learns to ignore.
    mockFind.mockResolvedValue([
      { actionType: 'pull_request_review_write', connector: 'github', targetVersion: null, createdAt: new Date() },
    ]);
    const a = await ask();
    expect(a.verdict).toBe('acted');
    expect(a.unobserved).toContain('sandbox_shell');
  });
});
