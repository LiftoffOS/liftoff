import {
  substituteRunId,
  branchMatchesGlob,
  evaluateExternalChecks,
  RUN_BRANCH_PREFIX,
  type GithubRunState,
} from './external-checks';

describe('external-checks pure evaluator (C4)', () => {
  const runId = 'build-123';

  it('substituteRunId replaces every <runId>', () => {
    expect(substituteRunId('liftoff/<runId>/*', runId)).toBe('liftoff/build-123/*');
    expect(substituteRunId(RUN_BRANCH_PREFIX, runId)).toBe('liftoff/build-123/');
  });

  it('branchMatchesGlob handles the * wildcard', () => {
    expect(branchMatchesGlob('liftoff/build-123/fix', 'liftoff/build-123/*')).toBe(true);
    expect(branchMatchesGlob('liftoff/other/fix', 'liftoff/build-123/*')).toBe(false);
    expect(branchMatchesGlob('main', 'liftoff/build-123/*')).toBe(false);
  });

  const state = (over: Partial<GithubRunState> = {}): GithubRunState => ({
    branches: ['main', 'liftoff/build-123/issue-1-fix'],
    prs: [{ number: 7, head: 'liftoff/build-123/issue-1-fix', state: 'open', mergeable_state: 'clean' }],
    headChecksSuccess: true,
    ...over,
  });

  it('passes when branch exists + PR open + checks green + mergeState match', () => {
    const r = evaluateExternalChecks(
      { provider: 'github', branchExists: 'liftoff/<runId>/*', prOpen: true, checksGreen: true, mergeState: 'clean' },
      state(),
      runId,
    );
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('fails branchExists when no matching branch', () => {
    const r = evaluateExternalChecks(
      { provider: 'github', branchExists: 'liftoff/<runId>/*' },
      state({ branches: ['main'] }),
      runId,
    );
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('no branch matching');
  });

  it('fails prOpen when the run PR is closed', () => {
    const r = evaluateExternalChecks(
      { provider: 'github', prOpen: true },
      state({ prs: [{ number: 7, head: 'liftoff/build-123/issue-1-fix', state: 'closed' }] }),
      runId,
    );
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('no OPEN pull request');
  });

  it("fails checksGreen when head status isn't success", () => {
    const r = evaluateExternalChecks({ provider: 'github', prOpen: true, checksGreen: true }, state({ headChecksSuccess: false }), runId);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes('status checks'))).toBe(true);
  });

  it('ignores PRs on other runs (isolation by run-id namespace)', () => {
    const r = evaluateExternalChecks(
      { provider: 'github', prOpen: true },
      state({ prs: [{ number: 9, head: 'liftoff/other-run/x', state: 'open' }] }),
      runId,
    );
    expect(r.ok).toBe(false);
  });
});
