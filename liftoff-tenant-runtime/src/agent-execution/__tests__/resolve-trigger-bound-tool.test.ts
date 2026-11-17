// Trigger-bound tool resolution.
//
// The defect this mechanism removes: GitHub and GitLab publish the SAME
// entityType ('PullRequest') on the same topic, deliberately, so one
// subscription serves both hosts. But a workflow step could only name one
// host's alias — so a GitHub pull request executed GitLab tools, and the
// approval card truthfully labelled the run "Gitlab" for work living on GitHub.
//
// These tests pin the two properties that matter: it resolves to the host that
// ACTUALLY fired, and it refuses rather than guesses. Refusing matters more —
// calling the wrong operation on the right host, or the right operation on an
// arbitrary instance, both read as success.

import {
  resolveTriggerBoundTool,
  CANONICAL_OPS,
  TRIGGER_ALIAS,
} from '../resolve-trigger-bound-tool';

const GITLAB = 'gitlab-1924102e';
const GITHUB = 'github-7d07a896';

const catalog = (...names: string[]) => new Set(names);

// GitHub's pull_request_read is one tool behind a required `method`. The enum
// here mirrors a live schema; resolution VERIFIES against it rather than
// assuming, which is the rule that caught `get_pull_request` not existing.
const PR_READ_SCHEMA = {
  properties: {
    method: { enum: ['get', 'get_diff', 'get_files', 'get_comments', 'get_reviews'] },
    owner: {}, repo: {}, pullNumber: {},
  },
};
const tools = [
  { name: `${GITLAB}__get_merge_request` },
  { name: `${GITLAB}__get_merge_request_diffs` },
  { name: `${GITLAB}__get_merge_request_notes` },
  { name: `${GITLAB}__create_merge_request_note` },
  { name: `${GITHUB}__pull_request_read`, input_schema: PR_READ_SCHEMA },
  { name: `${GITHUB}__add_issue_comment` },
  { name: 'slack_send_message' },
];

// The record the event carried, as the shared PullRequestDataSchema parses it.
const GH_RECORD = { repository: 'acme/api', repositoryId: 12345, number: 101 };
const GL_RECORD = { repository: 'https://gitlab.com/acme/widgets', repositoryId: 77, number: 5 };

// GitHub's names here are the REAL ones, enumerated from its live vendor MCP
// surface. Assuming `get_pull_request` would be wrong: GitHub does not have it
// — it consolidates PR reads behind `pull_request_read`. Anything invented here
// would make the tests agree
// with the code and both disagree with production.
const BOTH_HOSTS = catalog(
  `${GITLAB}__get_merge_request`,
  `${GITLAB}__create_merge_request_note`,
  `${GITHUB}__pull_request_read`,
  `${GITHUB}__add_issue_comment`,
  `${GITHUB}__add_comment_to_pending_review`,
  'slack_send_message',
);

describe('resolveTriggerBoundTool', () => {
  it('resolves to GitHub and ADDRESSES the entity the way GitHub needs', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get`, 'github', tools, GH_RECORD);
    expect(r).toMatchObject({
      kind: 'resolved',
      toolName: `${GITHUB}__pull_request_read`,
      host: 'github',
      // owner/repo split out of `repository`, number as pullNumber, and the
      // closed-set `method` confirmed against the schema.
      args: { owner: 'acme', repo: 'api', pullNumber: 101, method: 'get' },
    });
  });

  it('resolves the SAME step to GitLab and addresses it GitLab\'s way', () => {
    // One workflow, two hosts, two different argument shapes — the whole point.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get`, 'gitlab', tools, GL_RECORD);
    expect(r).toMatchObject({
      kind: 'resolved',
      toolName: `${GITLAB}__get_merge_request`,
      host: 'gitlab',
      // project_id from repositoryId, NOT from `repository` — GitLab publishes
      // the project web URL there, and passing it as project_id cannot resolve.
      args: { project_id: 77, merge_request_iid: 5 },
    });
  });

  it('never passes GitLab\'s repository URL as a project id', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get`, 'gitlab', tools, GL_RECORD);
    expect(JSON.stringify((r as { args: unknown }).args)).not.toContain('https://');
  });

  it('picks the method that matches the operation, per op', () => {
    const diff = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get_diff`, 'github', tools, GH_RECORD);
    expect(diff).toMatchObject({ kind: 'resolved', args: { method: 'get_diff' } });
    const comments = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_list_comments`, 'github', tools, GH_RECORD);
    expect(comments).toMatchObject({ kind: 'resolved', args: { method: 'get_comments' } });
  });

  it('refuses when no known method value is legal on this schema', () => {
    // The vendor renamed its methods. Sending a stale one would call a real
    // tool with a wrong mode, which reads as success.
    const narrowed = tools.map((t) => t.name === `${GITHUB}__pull_request_read`
      ? { ...t, input_schema: { properties: { method: { enum: ['something_else'] }, owner: {}, repo: {}, pullNumber: {} } } }
      : t);
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get`, 'github', narrowed, GH_RECORD);
    expect(r.kind).toBe('error');
    expect((r as { reason: string }).reason).toContain('Refusing to guess');
  });

  it('refuses when the record cannot address the entity on that host', () => {
    // A GitHub record with no owner/repo is not addressable, and half an
    // address is worse than none: it would call the wrong repository.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get`, 'github', tools, { repository: 'no-slash', number: 1 });
    expect(r.kind).toBe('error');
    expect((r as { reason: string }).reason).toContain('half-addressed');
  });

  it('reports the name as resolvable when the run carried no record at all', () => {
    // Two questions, separated. The NAME resolves off the catalog; the entity
    // cannot be addressed without the record the event carried. A run treats
    // this as fatal — the refusal moved to the caller in service.ts, which is
    // the only party that knows it is a run — while a pre-flight check, which
    // never has an event, can now judge the half it is able to.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get`, 'github', tools, undefined);
    expect(r.kind).toBe('resolvable');
    expect((r as { toolName: string }).toolName).toBe(`${GITHUB}__pull_request_read`);
    expect((r as { host: string }).host).toBe('github');
  });

  it('leaves an ordinary host-specific step alone', () => {
    expect(resolveTriggerBoundTool(`${GITLAB}__get_merge_request`, 'github', BOTH_HOSTS))
      .toEqual({ kind: 'not_applicable' });
    expect(resolveTriggerBoundTool('slack_send_message', 'github', BOTH_HOSTS))
      .toEqual({ kind: 'not_applicable' });
  });

  it('refuses when the triggering host has no tool matching the operation', () => {
    // GitHub's surface is vendor-defined and discovered per tenant; if none of
    // the known names is present, the surface changed. Guessing here would call
    // some other GitHub tool and look like it worked.
    const r = resolveTriggerBoundTool(
      `${TRIGGER_ALIAS}__pr_add_comment`,
      'github',
      catalog(`${GITHUB}__pull_request_read`),
    );
    expect(r.kind).toBe('error');
    expect((r as { reason: string }).reason).toContain('Refusing to guess');
  });

  it('refuses when two instances of the same host both match', () => {
    // Two GitHub connectors bound: picking one would act on an arbitrary repo.
    const r = resolveTriggerBoundTool(
      `${TRIGGER_ALIAS}__pr_get`,
      'github',
      catalog('github-7d07a896__pull_request_read', 'github-aaaa1111__pull_request_read'),
    );
    expect(r.kind).toBe('error');
    expect((r as { reason: string }).reason).toContain('arbitrary repository');
    expect((r as { reason: string }).reason).toContain('2 different connector instances');
  });

  it('skips on a run with no connector trigger, naming why', () => {
    // Deliberately a skip and not an error. As an error, one trigger-bound step
    // made the WHOLE graph event-only: the same workflow could not be fired on a
    // schedule or by hand, and it stopped at step zero instead of running the
    // steps that have nothing to do with the trigger.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get`, undefined, BOTH_HOSTS);
    expect(r.kind).toBe('skip');
    expect((r as { reason: string }).reason).toContain('no connector event trigger');
    // No host to name, because there was no triggering connector at all.
    expect((r as { host?: string }).host).toBeUndefined();
  });

  it('refuses an operation that is not in the vocabulary', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_delete_repo`, 'github', BOTH_HOSTS);
    expect(r.kind).toBe('error');
    expect((r as { reason: string }).reason).toContain('not a canonical operation');
  });

  it('refuses a host the operation does not declare', () => {
    const r = resolveTriggerBoundTool(
      `${TRIGGER_ALIAS}__pr_get`,
      'bitbucket',
      catalog('bitbucket-cccc3333__pull_request_read'),
    );
    expect(r.kind).toBe('error');
    expect((r as { reason: string }).reason).toContain('declares no operation for that host');
  });

  it('matches a connector type containing an underscore', () => {
    // Aliases use dashes; the connector type may not. Reading the type straight
    // out of the alias would never match.
    const r = resolveTriggerBoundTool(
      `${TRIGGER_ALIAS}__pr_get`,
      'my_host',
      catalog('my-host-12345678__pull_request_read'),
    );
    // my_host declares nothing, so this must be a declaration error rather than
    // a prefix-matching failure — proving the prefix itself matched.
    expect((r as { reason: string }).reason).toContain('declares no operation for that host');
  });

  it('picks the preferred name when several candidates are present', () => {
    // GitHub publishes BOTH add_issue_comment and add_comment_to_pending_review.
    // That is not ambiguity — the candidate list is ordered intent. The first
    // posts to the PR conversation, which is what a review note means here; the
    // second attaches to a pending review thread that may not exist.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_add_comment`, 'github', tools, GH_RECORD);
    expect(r).toMatchObject({
      kind: 'resolved',
      toolName: `${GITHUB}__add_issue_comment`,
      // GitHub treats a PR as an issue for conversation comments.
      args: { owner: 'acme', repo: 'api', issue_number: 101 },
    });
  });

  it('maps diff and comments onto their own GitLab tools', () => {
    // GitLab has three genuinely separate tools where GitHub has one behind a
    // method. Both are canonical now because the runtime supplies arguments.
    expect(resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get_diff`, 'gitlab', tools, GL_RECORD))
      .toMatchObject({ kind: 'resolved', toolName: `${GITLAB}__get_merge_request_diffs` });
    expect(resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_list_comments`, 'gitlab', tools, GL_RECORD))
      .toMatchObject({ kind: 'resolved', toolName: `${GITLAB}__get_merge_request_notes` });
  });

  it('every declared operation names the shared polling entity type', () => {
    // The ops exist to serve events, and the event's entityType is the polling
    // vocabulary ('PullRequest'), NOT the host-specific tool tag
    // ('merge_request'). Those two do not join, and confusing them is what
    // makes a mapping look correct while matching nothing.
    for (const [op, spec] of Object.entries(CANONICAL_OPS)) {
      expect(spec.entityType).toBe('PullRequest');
      expect(Object.keys(spec.candidates).length).toBeGreaterThan(0);
      expect(op).toMatch(/^pr_/);
    }
  });

  it('every operation either names GitLab exactly or says GitLab does not need it', () => {
    // Tightened rather than relaxed when the review-flow ops arrived. Before,
    // an op HAD to carry a GitLab candidate; now it may instead declare GitLab
    // in skipHosts — but it must do ONE of the two, deliberately. Silently
    // omitting GitLab is what this forbids, because that reads at runtime as
    // "the host's surface changed" when the truth is nobody considered it.
    //
    // GitLab's names are ours and must be exact, never a guess list, so the
    // candidate form still allows exactly one.
    const offenders = Object.entries(CANONICAL_OPS)
      .filter(([, spec]) => {
        const named = spec.candidates.gitlab?.length;
        const skipped = spec.skipHosts?.gitlab;
        // Exactly one of the two, never both — a host that skips has nothing
        // to resolve to, and a reason short enough to be a placeholder is not
        // a decision.
        if (named && skipped) return true;
        if (named === 1) return false;
        return !(skipped && skipped.length > 20);
      })
      .map(([op]) => op);
    expect(offenders).toEqual([]);
  });
});

// ── Two shapes reach this resolver ───────────────────────────────────────────
// A POLLED record is the shared PullRequestDataSchema: repository is the string
// "owner/repo". A PUSHED record is the vendor webhook body, forwarded verbatim
// because githubEventMatches filters on its native fields — there repository is
// an OBJECT and the number is nested on pull_request.
//
// Reading only the polled shape produces repository="[object Object]" and a
// refusal: a synchronize webhook wakes the agent and step s1 cannot address
// the entity.
describe('the pushed webhook shape addresses the entity too', () => {
  it('reads owner/repo from the repository OBJECT, not String(obj)', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get`, 'github', tools, {
      repository: { full_name: 'acme/webapp', name: 'webapp', id: 42 },
      pull_request: { number: 42 },
    } as never);
    expect(r).toMatchObject({
      kind: 'resolved',
      args: { owner: 'acme', repo: 'webapp', pullNumber: 42, method: 'get' },
    });
  });

  it('still reads the polled shape', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get`, 'github', tools, {
      repository: 'acme/webapp',
      number: 42,
    } as never);
    expect(r).toMatchObject({
      kind: 'resolved',
      args: { owner: 'acme', repo: 'webapp', pullNumber: 42 },
    });
  });

  it('still refuses when neither shape names the entity', () => {
    // Refusing beats sending half-populated arguments at an arbitrary repo.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_get`, 'github', tools, {
      repository: { name: 'webapp' },
    } as never);
    expect(r.kind).toBe('error');
  });
});

// ── The review flow: one artifact, many anchored comments ────────────────────
// A review is ONE thing carrying N line-anchored comments. Posting the findings
// as loose conversation comments is a different, worse outcome. GitHub models
// the batch as a draft: open,
// attach, publish. GitLab has no draft, so both bracket ops SKIP there and the
// SAME graph runs on either host.
describe('the review flow resolves per host without the graph knowing which', () => {
  const REVIEW_WRITE_SCHEMA = {
    properties: {
      method: { enum: ['create', 'submit_pending', 'delete_pending', 'resolve_thread', 'unresolve_thread'] },
      owner: {}, repo: {}, pullNumber: {}, body: {}, event: {},
    },
  };
  const reviewTools = [
    { name: `${GITHUB}__pull_request_review_write`, input_schema: REVIEW_WRITE_SCHEMA },
    { name: `${GITHUB}__add_comment_to_pending_review` },
    { name: `${GITLAB}__create_merge_request_note` },
  ];

  it('opens a pending review on GitHub', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_review_begin`, 'github', reviewTools, GH_RECORD);
    expect(r).toMatchObject({
      kind: 'resolved',
      toolName: `${GITHUB}__pull_request_review_write`,
      args: { owner: 'acme', repo: 'api', pullNumber: 101, method: 'create' },
    });
  });

  it('publishes it with submit_pending, verified against the live enum', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_review_publish`, 'github', reviewTools, GH_RECORD);
    expect(r).toMatchObject({ kind: 'resolved', args: { method: 'submit_pending' } });
  });

  it('anchors a comment to the pending review', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_review_comment`, 'github', reviewTools, GH_RECORD);
    expect(r).toMatchObject({
      kind: 'resolved',
      toolName: `${GITHUB}__add_comment_to_pending_review`,
      // pullNumber, NOT issue_number: this tool addresses the pull request.
      args: { owner: 'acme', repo: 'api', pullNumber: 101 },
    });
  });

  it('SKIPS the bracket ops on GitLab rather than refusing them', () => {
    // Not an error: GitLab notes post directly, so there is no draft to open or
    // publish. A refusal would stop a run that has nothing wrong with it.
    for (const op of ['pr_review_begin', 'pr_review_publish']) {
      const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__${op}`, 'gitlab', reviewTools, GL_RECORD);
      expect(r.kind).toBe('skip');
      if (r.kind === 'skip') expect(r.reason).toMatch(/GitLab/);
    }
  });

  it('still posts the comment itself on GitLab', () => {
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_review_comment`, 'gitlab', reviewTools, GL_RECORD);
    expect(r).toMatchObject({
      kind: 'resolved',
      toolName: `${GITLAB}__create_merge_request_note`,
      args: { project_id: 77, merge_request_iid: 5 },
    });
  });

  it('skip is decided before candidates, so GitLab is never called tool-less', () => {
    // skipHosts is consulted first; otherwise GitLab would be reported as
    // missing pull_request_review_write, a tool it was never going to need.
    const r = resolveTriggerBoundTool(`${TRIGGER_ALIAS}__pr_review_begin`, 'gitlab', [], GL_RECORD);
    expect(r.kind).toBe('skip');
  });
});

