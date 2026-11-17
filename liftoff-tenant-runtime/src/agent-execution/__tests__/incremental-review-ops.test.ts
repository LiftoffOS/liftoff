// Scoping a re-review to what changed, and reading what was already said.
//
// THE DEFECT. `pr_get_diff` returns the whole pull request, so every push to an
// open PR makes the reviewer read everything again and re-derive the same
// findings in different words — several on ONE line, none of them
// byte-identical, which is why matching the text cannot remove them.
//
// THE SURFACE, enumerated from the live server rather than assumed. GitHub's
// vendor MCP server publishes 41 tools and none is the compare endpoint, and
// its commits endpoint refuses a range (`/commits/{base}...{head}` → 422 "No
// commit found for SHA", where the same pair through `/compare/` → 200). So the
// increment is `get_commit` + `detail: full_patch`, and the fixtures below use
// the REAL names and the REAL enums off that server. Inventing either would
// make these tests agree with the code and both disagree with production, which
// is the failure this file's sibling was written to stop.

import {
  resolveTriggerBoundTool,
  CANONICAL_OPS,
  TRIGGER_ALIAS,
} from '../resolve-trigger-bound-tool';

const GITHUB = 'github-dd4c4689';
const GITLAB = 'gitlab-1924102e';

// The live enums, copied off `tools/list` against api.githubcopilot.com.
const PR_READ_SCHEMA = {
  properties: {
    method: {
      enum: ['get', 'get_diff', 'get_status', 'get_files', 'get_commits',
        'get_review_comments', 'get_reviews', 'get_comments', 'get_check_runs'],
    },
    owner: {}, repo: {}, pullNumber: {},
  },
};
const GET_COMMIT_SCHEMA = {
  properties: {
    detail: { enum: ['none', 'stats', 'full_patch'] },
    owner: {}, repo: {}, sha: {},
  },
};

const tools = [
  { name: `${GITHUB}__pull_request_read`, input_schema: PR_READ_SCHEMA },
  { name: `${GITHUB}__get_commit`, input_schema: GET_COMMIT_SCHEMA },
  { name: `${GITLAB}__get_merge_request_diffs` },
  { name: `${GITLAB}__get_merge_request_notes` },
];

/** A GitHub `pull_request` webhook with action `synchronize`, in the shape it
 *  arrives: repository as an OBJECT, number nested, and the before/after pair
 *  that is the only description of an increment in the whole envelope. */
const SYNCHRONIZE = {
  repository: { full_name: 'acme/webapp' },
  pull_request: { number: 42, head: { sha: '9ac4ea69353befafdc7942faca3a63c9424ad43e' } },
  before: 'db10bcb9f9086b6f10d83b7e1d66307669d253fe',
  after: '9ac4ea69353befafdc7942faca3a63c9424ad43e',
};

/** The same PR delivered as `opened`. No push happened, so there is no before
 *  and no after — and that absence is the fact the incremental op must act on. */
const OPENED = {
  repository: { full_name: 'acme/webapp' },
  pull_request: { number: 42 },
};

const GL_RECORD = { repository: 'https://gitlab.com/acme/widgets', repositoryId: 77, number: 5 };

describe('pr_get_diff_since — the increment', () => {
  it('asks GitHub for the pushed commit, with the patch and not just stats', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get_diff_since`, 'github', tools, SYNCHRONIZE);
    expect(r).toMatchObject({
      kind: 'resolved',
      toolName: `${GITHUB}__get_commit`,
      host: 'github',
      args: {
        owner: 'acme',
        repo: 'webapp',
        sha: '9ac4ea69353befafdc7942faca3a63c9424ad43e',
        // `stats` is the tool's DEFAULT and carries filenames and line counts
        // with no patch. A reviewer handed stats would be reviewing a list of
        // filenames and would report success for having done so.
        detail: 'full_patch',
      },
    });
  });

  it('never sends the PR number to a commit read', () => {
    // get_commit addresses a COMMIT. Carrying pullNumber across from the other
    // PR ops would send an argument the tool does not declare.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get_diff_since`, 'github', tools, SYNCHRONIZE);
    expect((r as { args: Record<string, unknown> }).args).not.toHaveProperty('pullNumber');
  });

  it('REFUSES when the delivery carried no increment', () => {
    // `opened` has no before/after. The dangerous alternative is defaulting the
    // sha to the branch — get_commit accepts a branch ref, so that would
    // silently return whatever the tip happens to be at read time: a window
    // that looks like an increment and is not.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get_diff_since`, 'github', tools, OPENED);
    expect(r.kind).toBe('error');
    expect((r as { reason: string }).reason).toContain('half-addressed');
  });

  it('names `after` in the refusal, since that is what was missing', () => {
    // repository and number both read fine on an `opened` record. Without the
    // increment field in the message an operator sees a fully-addressed record
    // refused for no visible reason.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get_diff_since`, 'github', tools, OPENED);
    expect((r as { reason: string }).reason).toContain('after=""');
  });

  it('refuses a ref where a sha is required', () => {
    // A delivery that put a branch name in `after` must not resolve. Same
    // reason as the `opened` case: a ref is read at request time.
    const r = resolveTriggerBoundTool(
      `${TRIGGER_ALIAS}__pr_get_diff_since`, 'github', tools,
      { ...OPENED, after: 'refs/heads/main' },
    );
    expect(r.kind).toBe('error');
  });

  it('falls back to the head sha the same envelope carries', () => {
    const r = resolveTriggerBoundTool(
      `${TRIGGER_ALIAS}__pr_get_diff_since`, 'github', tools,
      { ...SYNCHRONIZE, after: null },
    );
    expect(r).toMatchObject({ args: { sha: '9ac4ea69353befafdc7942faca3a63c9424ad43e' } });
  });

  it('refuses when the vendor drops full_patch from the enum', () => {
    // A rename must not degrade to `stats`. The same rule that caught
    // `get_pull_request` not existing.
    const narrowed = tools.map((t) => t.name === `${GITHUB}__get_commit`
      ? { ...t, input_schema: { properties: { detail: { enum: ['none', 'stats'] }, owner: {}, repo: {}, sha: {} } } }
      : t);
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get_diff_since`, 'github', narrowed, SYNCHRONIZE);
    expect(r.kind).toBe('error');
    expect((r as { reason: string }).reason).toContain('Refusing to guess');
  });

  it('gives GitLab the whole merge request, because that is its smallest scope', () => {
    // GitLab's MR surface is five functions and none is a per-commit or range
    // diff. Skipping would hand the reviewer NO diff, which is a worse failure
    // than a wide one — so it resolves, and the resolved tool name is what
    // tells an operator this host could not narrow.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get_diff_since`, 'gitlab', tools, GL_RECORD);
    expect(r).toMatchObject({
      kind: 'resolved',
      toolName: `${GITLAB}__get_merge_request_diffs`,
      args: { project_id: 77, merge_request_iid: 5 },
    });
  });
});

describe('pr_list_commits — so a narrowed review is not silently narrow', () => {
  it('reads the pull request commit list', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_list_commits`, 'github', tools, SYNCHRONIZE);
    expect(r).toMatchObject({
      kind: 'resolved',
      toolName: `${GITHUB}__pull_request_read`,
      args: { owner: 'acme', repo: 'webapp', pullNumber: 42, method: 'get_commits' },
    });
  });

  it('resolves on an opened delivery too', () => {
    // Unlike the increment, the commit list needs no before/after — it is
    // addressed by pull request. It must not inherit the refusal.
    expect(resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_list_commits`, 'github', tools, OPENED).kind)
      .toBe('resolved');
  });

  it('skips on GitLab, with the reason stated', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_list_commits`, 'gitlab', tools, GL_RECORD);
    expect(r.kind).toBe('skip');
    expect((r as { reason: string }).reason).toContain('whole merge request');
  });
});

describe('pr_list_review_threads — what the reviewer already said', () => {
  it('asks for review threads, NOT the conversation', () => {
    // Verified against the live server: get_review_comments answers
    // `review_threads[]` with is_resolved / is_outdated and each thread's
    // path + line. `get_comments` answers issue-style comments with none of
    // that — no file, no line, no state.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_list_review_threads`, 'github', tools, SYNCHRONIZE);
    expect(r).toMatchObject({
      kind: 'resolved',
      args: { method: 'get_review_comments' },
    });
  });

  it('leaves pr_list_comments pointed where it always was', () => {
    // That op is in live graphs. Re-pointing it would change their behaviour
    // silently, which is why the new capability is a new op.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_list_comments`, 'github', tools, SYNCHRONIZE);
    expect(r).toMatchObject({ args: { method: 'get_comments' } });
  });

  it('answers the same question on GitLab through its notes', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_list_review_threads`, 'gitlab', tools, GL_RECORD);
    expect(r).toMatchObject({
      kind: 'resolved',
      toolName: `${GITLAB}__get_merge_request_notes`,
    });
  });
});

describe('the vocabulary itself', () => {
  it('declares every new op against the PullRequest polling entity', () => {
    // The tool-level entityType tag is host vocabulary ('merge_request' on
    // GitLab) and does not join with the event's. A mapping built on that tag
    // looks right and matches nothing.
    for (const op of ['pr_get_diff_since', 'pr_list_commits', 'pr_list_review_threads']) {
      expect(CANONICAL_OPS[op]).toBeDefined();
      expect(CANONICAL_OPS[op].entityType).toBe('PullRequest');
    }
  });

  it('keeps every op name parseable as exactly one alias and one operation', () => {
    // Resolution splits on the FIRST `__`, so an op name containing one would
    // be unparseable. `pr_list_commits` and `pr_list_comments` are one letter
    // apart on purpose-adjacent concepts; this at least holds their shape.
    for (const op of Object.keys(CANONICAL_OPS)) {
      expect(op).not.toContain('__');
    }
  });
});
