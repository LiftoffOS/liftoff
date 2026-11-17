// C4 — external post-run checks polled against the fixture GitHub repo.
//
// Activated by the tr-runner's `--external-checks=github`. The SWE suite's scenarios
// (@liftoffos/agent-test-scenarios) carry an optional `externalChecks` field: after the agent
// run's own assertion passes, the runner confirms the SIDE EFFECT actually landed on the fixture
// repo (a branch was cut, a PR is open, checks are green). Per-run isolation uses a run-id-prefixed
// branch namespace `liftoff/<runId>/*`; teardown closes the run's PRs and deletes its branches even
// on failure so the fixture repo doesn't accumulate cruft.
//
// The pure evaluator (evaluateExternalChecks + the glob/substitution helpers) is unit-tested; the
// GitHub I/O (fetchGithubRunState / teardownGithubRun) uses fetch against api.github.com.

import type { ExternalChecks } from '@liftoffos/agent-test-scenarios';

const GH = 'https://api.github.com';
/** The branch namespace every smoke run confines itself to (see the injected prompt suffix). */
export const RUN_BRANCH_PREFIX = 'liftoff/<runId>/';

export function substituteRunId(pattern: string, runId: string): string {
  return pattern.replace(/<runId>/g, runId);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Minimal glob — only `*` (matches any run of chars). Sufficient for `liftoff/<runId>/*`. */
export function branchMatchesGlob(branch: string, glob: string): boolean {
  const re = new RegExp('^' + glob.split('*').map(escapeRe).join('.*') + '$');
  return re.test(branch);
}

export interface GithubRunState {
  branches: string[];
  prs: Array<{ number: number; head: string; state: string; mergeable_state?: string }>;
  /** Combined status of the run PR's head SHA — undefined when there is no run PR. */
  headChecksSuccess?: boolean;
}

/** Pure: evaluate a scenario's externalChecks against a fetched repo state. No I/O. */
export function evaluateExternalChecks(
  checks: ExternalChecks,
  state: GithubRunState,
  runId: string,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const runGlob = substituteRunId(RUN_BRANCH_PREFIX + '*', runId);
  const runPrs = state.prs.filter((p) => branchMatchesGlob(p.head, runGlob));

  if (checks.branchExists) {
    const want = substituteRunId(checks.branchExists, runId);
    if (!state.branches.some((b) => branchMatchesGlob(b, want))) {
      failures.push(`external: no branch matching "${want}"`);
    }
  }
  if (checks.prOpen && !runPrs.some((p) => p.state === 'open')) {
    failures.push('external: no OPEN pull request on the run branch');
  }
  if (checks.checksGreen && state.headChecksSuccess !== true) {
    failures.push('external: PR head status checks are not all successful');
  }
  if (checks.mergeState) {
    const pr = runPrs.find((p) => p.state === 'open');
    if (!pr) failures.push(`external: expected mergeable_state "${checks.mergeState}" but no open run PR`);
    else if (pr.mergeable_state !== checks.mergeState) {
      failures.push(`external: mergeable_state "${pr.mergeable_state ?? '?'}" != "${checks.mergeState}"`);
    }
  }
  return { ok: failures.length === 0, failures };
}

// ── GitHub I/O ────────────────────────────────────────────────────────────

function ghHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'swe-smoke',
  };
}

async function ghJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GH}${path}`, { ...init, headers: { ...ghHeaders(token), ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`GitHub ${init?.method ?? 'GET'} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // DELETE (and some PATCH) return 204 No Content with an empty body — don't JSON.parse "".
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Fetch the repo state needed to evaluate a run's externalChecks. `repo` is `owner/name`. */
export async function fetchGithubRunState(repo: string, runId: string, token: string): Promise<GithubRunState> {
  const branches = await ghJson<Array<{ name: string }>>(`/repos/${repo}/branches?per_page=100`, token);
  const prs = await ghJson<Array<{ number: number; head: { ref: string; sha: string }; state: string; mergeable_state?: string }>>(
    `/repos/${repo}/pulls?state=all&per_page=100`,
    token,
  );
  const runGlob = substituteRunId(RUN_BRANCH_PREFIX + '*', runId);
  const runPr = prs.find((p) => branchMatchesGlob(p.head.ref, runGlob) && p.state === 'open');
  let headChecksSuccess: boolean | undefined;
  if (runPr) {
    // Combined *status* (Statuses API) OR *check-runs* (Actions report as check-runs, not statuses).
    const combined = await ghJson<{ state: string }>(`/repos/${repo}/commits/${runPr.head.sha}/status`, token);
    let ok = combined.state === 'success';
    if (!ok) {
      const checks = await ghJson<{ check_runs?: Array<{ status: string; conclusion: string | null }> }>(
        `/repos/${repo}/commits/${runPr.head.sha}/check-runs`,
        token,
      );
      const runs = checks.check_runs ?? [];
      ok = runs.length > 0 && runs.every((c) => c.status === 'completed' && ['success', 'neutral', 'skipped'].includes(c.conclusion ?? ''));
    }
    headChecksSuccess = ok;
  }
  return {
    branches: branches.map((b) => b.name),
    prs: prs.map((p) => ({ number: p.number, head: p.head.ref, state: p.state, mergeable_state: p.mergeable_state })),
    headChecksSuccess,
  };
}

/**
 * Reset the fixture repo to a known baseline before a run, so the smoke is repeatable even though
 * scenarios mutate it (a merge fixes the defect; a merged PR auto-closes the issue). Force-resets
 * main to the `baseline` branch, reopens issue #1, and clears any leftover `liftoff/*` branches/PRs
 * from earlier failed runs. Best-effort — a reset failure logs but does not abort the run.
 */
export async function resetGithubFixture(repo: string, token: string): Promise<string[]> {
  const notes: string[] = [];
  try {
    const base = await ghJson<{ object: { sha: string } }>(`/repos/${repo}/git/refs/heads/baseline`, token);
    await ghJson(`/repos/${repo}/git/refs/heads/main`, token, {
      method: 'PATCH',
      body: JSON.stringify({ sha: base.object.sha, force: true }),
    });
    notes.push(`reset main → baseline (${base.object.sha.slice(0, 7)})`);
  } catch (e) {
    notes.push(`reset main failed: ${(e as Error).message}`);
  }
  try {
    await ghJson(`/repos/${repo}/issues/1`, token, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) });
    notes.push('reopened issue #1');
  } catch (e) {
    notes.push(`reopen issue #1 failed: ${(e as Error).message}`);
  }
  // Clear debris from any prior run's branches/PRs (glob over ALL liftoff/* namespaces).
  try {
    const prs = await ghJson<Array<{ number: number; head: { ref: string } }>>(`/repos/${repo}/pulls?state=open&per_page=100`, token);
    for (const pr of prs.filter((p) => p.head.ref.startsWith('liftoff/'))) {
      try { await ghJson(`/repos/${repo}/pulls/${pr.number}`, token, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) }); } catch { /* best-effort */ }
    }
    const branches = await ghJson<Array<{ name: string }>>(`/repos/${repo}/branches?per_page=100`, token);
    for (const b of branches.filter((x) => x.name.startsWith('liftoff/'))) {
      try { await ghJson(`/repos/${repo}/git/refs/heads/${b.name}`, token, { method: 'DELETE' }); } catch { /* best-effort */ }
    }
  } catch (e) {
    notes.push(`debris cleanup failed: ${(e as Error).message}`);
  }
  return notes;
}

/** The open PR on this run's branch namespace, if one exists (created by an earlier swe scenario). */
export async function findOpenRunPr(
  repo: string,
  runId: string,
  token: string,
): Promise<{ number: number; headSha: string; head: string } | null> {
  const runGlob = substituteRunId(RUN_BRANCH_PREFIX + '*', runId);
  const prs = await ghJson<Array<{ number: number; head: { ref: string; sha: string }; state: string }>>(
    `/repos/${repo}/pulls?state=open&per_page=100`,
    token,
  );
  const pr = prs.find((p) => branchMatchesGlob(p.head.ref, runGlob));
  return pr ? { number: pr.number, headSha: pr.head.sha, head: pr.head.ref } : null;
}

/**
 * Seed a review with a line comment on the run's PR so the review-cycle scenarios have concrete
 * feedback to reply to. Uses event=COMMENT — the ONE review event you may submit on your own PR
 * (APPROVE / REQUEST_CHANGES are blocked for self-review), so no second GitHub identity is needed.
 * The comment line is taken from the PR's own diff so GitHub accepts it. Best-effort.
 */
export async function seedReviewComment(repo: string, prNumber: number, headSha: string, token: string): Promise<string[]> {
  try {
    const files = await ghJson<Array<{ filename: string; patch?: string }>>(`/repos/${repo}/pulls/${prNumber}/files`, token);
    const target = files.find((f) => f.filename === 'src/config-loader.js' && f.patch) ?? files.find((f) => f.patch);
    if (!target?.patch) return [`seed review: PR #${prNumber} has no diff to comment on`];
    const m = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(target.patch);
    const line = m ? parseInt(m[1], 10) : 1;
    await ghJson(`/repos/${repo}/pulls/${prNumber}/reviews`, token, {
      method: 'POST',
      body: JSON.stringify({
        commit_id: headSha,
        event: 'COMMENT',
        body: 'One change requested before this can be approved.',
        comments: [{ path: target.filename, line, body: 'Please also add a unit test covering the null/undefined input case, then push.' }],
      }),
    });
    return [`seeded COMMENT review on PR #${prNumber} (${target.filename}:${line})`];
  } catch (e) {
    return [`seed review on PR #${prNumber} failed: ${(e as Error).message}`];
  }
}

/** Close every OPEN PR on a `liftoff/<runId>/*` branch and delete those branches. Best-effort. */
export async function teardownGithubRun(repo: string, runId: string, token: string): Promise<string[]> {
  const notes: string[] = [];
  const runGlob = substituteRunId(RUN_BRANCH_PREFIX + '*', runId);
  try {
    const prs = await ghJson<Array<{ number: number; head: { ref: string }; state: string }>>(
      `/repos/${repo}/pulls?state=open&per_page=100`,
      token,
    );
    for (const pr of prs.filter((p) => branchMatchesGlob(p.head.ref, runGlob))) {
      try {
        await ghJson(`/repos/${repo}/pulls/${pr.number}`, token, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
        notes.push(`closed PR #${pr.number}`);
      } catch (e) { notes.push(`close PR #${pr.number} failed: ${(e as Error).message}`); }
    }
    const branches = await ghJson<Array<{ name: string }>>(`/repos/${repo}/branches?per_page=100`, token);
    for (const b of branches.filter((x) => branchMatchesGlob(x.name, runGlob))) {
      try {
        await ghJson(`/repos/${repo}/git/refs/heads/${b.name}`, token, { method: 'DELETE' });
        notes.push(`deleted ${b.name}`);
      } catch (e) { notes.push(`delete ${b.name} failed: ${(e as Error).message}`); }
    }
  } catch (e) {
    notes.push(`teardown enumeration failed: ${(e as Error).message}`);
  }
  return notes;
}
