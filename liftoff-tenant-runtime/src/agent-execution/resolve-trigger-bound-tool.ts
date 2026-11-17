// Trigger-bound tool resolution — a workflow step that names an OPERATION
// instead of a HOST, resolved at dispatch to whichever host actually fired.
//
// Why this exists
// ───────────────
// GitHub and GitLab publish byte-identical polling rows for PullRequest, and
// connector-service says why in as many words:
//
//   "GitLabClient polls /merge_requests + /issues and publishes under the SAME
//    entityTypes GitHub uses — 'PullRequest' ... so one software-delivery-team
//    subscription matches events from both hosts."
//
// Host-agnostic TRIGGERING is the intent. But a workflow step could only ever
// name one host's alias (`gitlab-1924102e__get_merge_request`), so whichever
// host it hardcoded, the other host's events ran against it. A GitHub pull
// request executed GitLab tools, and the approval card — which derives its
// label from the pending tool name, deliberately, as a trust anchor — then
// truthfully reported GitLab for work that lived on GitHub.
//
// A step may now name `trigger__<op>`. `trigger` is a reserved pseudo-alias
// meaning "the connector that woke this run".
//
// Why resolution is data-driven and not a name table
// ──────────────────────────────────────────────────
// The three hosts' tool surfaces come from three different authorities:
// GitLab's are ours (GITLAB_FUNCTIONS), GitHub's are defined by GitHub and
// discovered per-tenant from its vendor MCP server, and Bitbucket's are
// Composio-managed. A hardcoded GitHub name would be a guess about a surface we
// do not own and cannot see from here — which is the silent-wrong-call failure
// this whole line of work exists to remove.
//
// So each op declares CANDIDATE function names per host, ORDERED by preference,
// and resolution matches them against the LIVE catalog for this run. The
// earliest name actually present wins — the ordering is authored intent, not a
// coin toss.
//
// Two things are refused rather than guessed. NO candidate present means the
// host's surface has changed and any substitute would be invention. Tools from
// SEVERAL connector instances of the same host means choosing one would act on
// an arbitrary repository. Dispatching the wrong operation against the right
// host is worse than not dispatching, because it looks like it worked.
//
// The candidate lists are read off the live surface, not guessed: GitHub's
// vendor-MCP tools were enumerated and this list corrected against them. A
// guessed name such as `get_pull_request` does not exist.

/** Reserved alias meaning "whichever connector triggered this run". */
export const TRIGGER_ALIAS = 'trigger';

/** The record the event carried, as far as an adapter needs it.
 *
 *  TWO SHAPES REACH HERE, and this used to describe only one.
 *
 *  The POLLED shape is the shared PullRequestDataSchema (connector-service):
 *  `repository` is the string "owner/repo", `number` is the PR number.
 *
 *  The PUSHED shape is the vendor's own webhook body, forwarded verbatim
 *  because that is what the runtime's own `githubEventMatches` filters on —
 *  it reads `action`, `pull_request.draft`, `pull_request.merged` and
 *  `repository.full_name`, none of which survive normalization. There
 *  `repository` is an OBJECT and the number lives on `pull_request`.
 *
 *  Reading only the polled shape produced `repository="[object Object]"` and a
 *  refusal, so a webhook woke the agent and no step could address the entity.
 *  Normalizing at the publisher instead is not available: it would fix this and
 *  break every filter. So both shapes are read here, which is also what
 *  `event-trigger.ts` already does for Gmail's two payload shapes. */
export interface TriggerEntityRecord {
  /** Polled: "owner/repo". Pushed: the webhook's repository object. GitLab
   *  polled: the project WEB URL — not a project id. */
  repository?: string | { full_name?: string | null; name?: string | null; id?: number | string | null } | null;
  /** Host-native numeric repository id. GitLab's project id. */
  repositoryId?: number | string | null;
  /** Per-repository number: GitHub PR number, GitLab merge-request IID. */
  number?: number | string | null;
  /** Pushed shape only: GitHub nests the number here on a pull_request event. */
  pull_request?: { number?: number | string | null; head?: { sha?: string | null } | null } | null;
  /** Pushed shape only: GitLab nests it here on a merge_request event. */
  object_attributes?: { iid?: number | string | null } | null;
  /** What this delivery CHANGED, present only on a pushed `synchronize`.
   *
   *  GitHub sends `before` and `after` on a pull_request event whose action is
   *  `synchronize` — the branch head before and after the push. They are the
   *  only fields in the whole envelope that describe an INCREMENT rather than
   *  the pull request as a whole, which is why the incremental ops read them
   *  and every other op ignores them.
   *
   *  Absent on `opened` / `reopened` / `ready_for_review`, and absent on every
   *  polled record. That absence is meaningful, not missing data: there is no
   *  increment to scope to, so the incremental ops refuse rather than invent a
   *  window. */
  before?: string | null;
  after?: string | null;
}

/** A closed-set argument whose legal values must be confirmed against the live
 *  tool schema before use. GitHub's pull_request_read is one tool serving
 *  several operations behind a required `method`. */
export interface MethodBinding {
  arg: string;
  /** Ordered by preference; the first value the live schema actually declares
   *  wins. Never assumed — an unverifiable value is refused, not sent. */
  values: string[];
}

export interface CanonicalOp {
  /** Entity the op acts on, in the POLLING vocabulary (the event's entityType).
   *  Deliberately not the tool-level `entityType` tag, which is host-specific
   *  ('merge_request' on GitLab) and does not join with the event's. */
  entityType: string;
  /** Candidate function names per connector type, most-preferred first.
   *  GitLab's are authored from our own registry and are exact. Other hosts
   *  list plausible vendor names; the live catalog decides which exists. */
  candidates: Record<string, string[]>;
  /** Identity arguments, built per host from the event record.
   *
   *  These are NOT authorable. The distiller does not know which host will fire
   *  — that is the entire point of a trigger-bound step — and the identity
   *  arguments are host-shaped: GitHub wants owner/repo/pullNumber, GitLab
   *  wants project_id/merge_request_iid. A step therefore cannot carry them,
   *  and the runtime supplies them here because it is the only party that knows
   *  both the host and the record.
   *
   *  Returns null when the record lacks what the host needs, which is refused
   *  rather than sent half-populated. */
  identity: Record<string, (rec: TriggerEntityRecord) => Record<string, unknown> | null>;
  /** Per-host closed-set argument, when one tool serves several operations. */
  method?: Record<string, MethodBinding>;
  /** Hosts for which this operation is unnecessary rather than unavailable.
   *
   *  Consulted BEFORE candidates, so a host listed here is never reported as
   *  missing a tool it was never going to need. The value is the reason, which
   *  is logged — "not supported" and "not required" look identical in a graph
   *  that just carries on, and only one of them is worth investigating. */
  skipHosts?: Record<string, string>;
}

/** "owner/repo" from either shape.
 *
 *  Polled records carry the string; webhook bodies carry the object, whose
 *  `full_name` is already "owner/repo". `String(obj)` yields "[object Object]",
 *  which splits into no usable pair — the observed failure. */
export function repositorySlug(rec: TriggerEntityRecord): string {
  const r = rec.repository;
  if (typeof r === 'string') return r.trim();
  if (r && typeof r === 'object') return String(r.full_name ?? '').trim();
  return '';
}

/** GitHub addresses a PR by owner + repo + number. A repository value that is
 *  not "owner/repo" in either shape cannot be split into the two arguments the
 *  API needs. */
function githubOwnerRepo(rec: TriggerEntityRecord): { owner: string; repo: string } | null {
  const [owner, repo] = repositorySlug(rec).split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** The per-repository number from either shape. Polled records put it at the
 *  top level; a GitHub webhook nests it on `pull_request` and a GitLab one on
 *  `object_attributes.iid`. */
export function prNumber(rec: TriggerEntityRecord): number | null {
  for (const candidate of [rec.number, rec.pull_request?.number, rec.object_attributes?.iid]) {
    if (candidate === null || candidate === undefined || String(candidate).trim() === '') continue;
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** The head this delivery pushed, from a `synchronize` envelope.
 *
 *  `after` is the branch head AFTER the push, so its commit is the newest thing
 *  the pull request contains. Falls back to `pull_request.head.sha`, which the
 *  same envelope carries and which is the same commit — belt and braces for a
 *  delivery that omits the top-level pair.
 *
 *  Returns null when neither is present, which is how `opened`, `reopened` and
 *  every polled record land here. Null is REFUSED by the incremental ops rather
 *  than defaulted to the branch name: `get_commit` accepts a branch ref, so a
 *  default would silently return the tip commit of whatever the branch happens
 *  to be at read time — a window that looks like an increment and is not, which
 *  is the same class of failure as trusting a diverged compare. */
export function pushedHeadSha(rec: TriggerEntityRecord): string | null {
  for (const candidate of [rec.after, rec.pull_request?.head?.sha]) {
    const s = String(candidate ?? '').trim();
    // A 40-hex sha, or the abbreviated form GitHub also accepts. Anything else
    // is a ref name, and a ref is exactly what must not be used here.
    if (/^[0-9a-f]{7,40}$/i.test(s)) return s;
  }
  return null;
}

// The only import this module has, and it is a pure string function: a
// dispatch alias (`github-1a2b3c4d`) and a trigger source (`github`) have to be
// compared as TYPES, and `connectorTypeFromAlias` is already the one rule for
// that. target-ref does not import this module, so there is no cycle.
import { connectorTypeFromAlias } from '../action-ledger/target-ref';

/**
 * The revision a run was triggered on, for a call to the connector that fired
 * it — or null when the pairing does not hold.
 *
 * Pure and exported so the scoping rule is testable on its own. The rule has
 * three legs and each one is a way to get a wrong `target_version`:
 *
 *  - the run must have been fired by a connector event (a cron or a human has
 *    no revision to speak of);
 *  - the call must go to the connector TYPE that fired it, because a head sha
 *    describes that repository and not the Slack channel the same run posts to.
 *    Compared on type, since a dispatch alias carries an instance suffix
 *    (`github-1a2b3c4d`) and a trigger source does not;
 *  - the record must actually carry a sha. `pushedHeadSha` refuses a ref name,
 *    which is what keeps `opened`, `reopened` and every polled record at null
 *    rather than stamped with whatever the branch tip happened to be.
 */
export function triggerRevisionForConnector(
  // Deliberately structural rather than the `AgentTrigger` union: a
  // `custom_event` trigger's `source` is an OBJECT, and narrowing on
  // `kind === 'connector_event'` first is what makes reading it as a string
  // safe. Typing the parameter as the union would push that narrowing onto
  // every caller.
  trigger: { kind?: string; source?: unknown } | undefined,
  eventRecord: unknown,
  connector: string,
): string | null {
  if (trigger?.kind !== 'connector_event') return null;
  const source = typeof trigger.source === 'string' ? trigger.source : '';
  if (!source) return null;
  if (connectorTypeFromAlias(connector) !== connectorTypeFromAlias(source)) return null;
  if (!eventRecord || typeof eventRecord !== 'object') return null;
  return pushedHeadSha(eventRecord as TriggerEntityRecord);
}

/** GitLab addresses a merge request by project id + IID. `repository` holds the
 *  project WEB URL on GitLab, so `repositoryId` is the only usable identifier —
 *  passing the URL as project_id is a documented live failure. */
function gitlabProject(rec: TriggerEntityRecord): { project_id: string | number } | null {
  // Polled records carry repositoryId; a webhook body carries the id on the
  // project/repository object instead. Same two-shape problem as the slug, and
  // fixing only GitHub would leave GitLab to fail the identical way the day its
  // webhook is wired.
  const nested = (rec.repository && typeof rec.repository === 'object') ? rec.repository.id : undefined;
  const id = rec.repositoryId ?? nested;
  if (id === null || id === undefined || String(id).trim() === '') return null;
  return { project_id: typeof id === 'number' ? id : String(id) };
}

export const CANONICAL_OPS: Record<string, CanonicalOp> = {
  pr_get: {
    entityType: 'PullRequest',
    candidates: {
      gitlab: ['get_merge_request'],
      // No `get_pull_request` on GitHub: PR reads sit behind `pull_request_read`
      // under a required `method`. Read off the live surface, not assumed.
      github: ['pull_request_read'],
    },
    identity: {
      github: (rec) => {
        const or = githubOwnerRepo(rec); const n = prNumber(rec);
        return or && n ? { ...or, pullNumber: n } : null;
      },
      gitlab: (rec) => {
        const p = gitlabProject(rec); const n = prNumber(rec);
        return p && n ? { ...p, merge_request_iid: n } : null;
      },
    },
    method: { github: { arg: 'method', values: ['get', 'read', 'get_pull_request'] } },
  },
  pr_get_diff: {
    entityType: 'PullRequest',
    candidates: {
      gitlab: ['get_merge_request_diffs'],
      github: ['pull_request_read'],
    },
    identity: {
      github: (rec) => {
        const or = githubOwnerRepo(rec); const n = prNumber(rec);
        return or && n ? { ...or, pullNumber: n } : null;
      },
      gitlab: (rec) => {
        const p = gitlabProject(rec); const n = prNumber(rec);
        return p && n ? { ...p, merge_request_iid: n } : null;
      },
    },
    method: { github: { arg: 'method', values: ['get_diff', 'diff', 'get_files', 'files'] } },
  },
  // ── Scoping a re-review to what changed ────────────────────────────────
  //
  // `pr_get_diff` always returns the WHOLE pull request. So every push to an
  // open PR made the reviewer read everything again and re-derive the same
  // findings in different words. A PR accumulates repeated inline comments,
  // several on one line, none byte-identical, which is why de-duplicating the
  // text was never going to work.
  //
  // WHAT THE HOST ACTUALLY OFFERS, enumerated live rather than assumed.
  // GitHub's vendor MCP server publishes 41 tools and NONE of them is the
  // compare endpoint (`GET /repos/{o}/{r}/compare/{base}...{head}`). The
  // commits endpoint does not accept a range either — `GET /repos/{o}/{r}/
  // commits/{base}...{head}` answers 422 "No commit found for SHA", while the
  // same pair through `/compare/` answers 200. A range diff is simply not
  // reachable from an agent's tool surface.
  //
  // What IS reachable is `get_commit` with `detail: 'full_patch'`, which
  // returns one commit's files and patches. On the overwhelmingly common
  // synchronize — one commit pushed to an open PR — that IS the increment,
  // exactly.
  //
  // THE GAP, STATED RATHER THAN HIDDEN. When a push carries several commits,
  // this covers the tip only. `get_commit`'s response does not include
  // `parents` (verified against the live server: the payload is sha, html_url,
  // commit, author, committer, stats, files), so neither the request nor the
  // response can prove how much of the push was seen. An undetectable partial
  // review is worse than a noisy complete one, so this op is NOT meant to be
  // used alone — `pr_list_commits` below exists so the graph can see the whole
  // commit list and know when the increment is narrower than the push. Pairing
  // them is what the distiller's guidance asks for.
  pr_get_diff_since: {
    entityType: 'PullRequest',
    candidates: {
      github: ['get_commit'],
      // GitLab's MR surface is five functions and none is a per-commit or
      // range diff, so the smallest scope this host can express IS the whole
      // merge request. Resolving to it rather than skipping is deliberate: a
      // skip would hand the reviewer NO diff at all, which is a worse failure
      // than a wide one. The degradation is not silent — resolution logs the
      // tool it chose, so `get_merge_request_diffs` on the incremental branch
      // reads as "this host could not narrow it".
      gitlab: ['get_merge_request_diffs'],
    },
    identity: {
      github: (rec) => {
        const or = githubOwnerRepo(rec); const sha = pushedHeadSha(rec);
        return or && sha ? { ...or, sha } : null;
      },
      gitlab: (rec) => {
        const p = gitlabProject(rec); const n = prNumber(rec);
        return p && n ? { ...p, merge_request_iid: n } : null;
      },
    },
    // `detail` is a closed set on the live schema (none | stats | full_patch)
    // and the default is `stats`, which carries filenames and line counts but
    // NO patch. A reviewer given stats would be reviewing a list of filenames.
    // Verified against the schema by the same machinery that checks `method`,
    // so a vendor rename is refused instead of silently falling back.
    method: { github: { arg: 'detail', values: ['full_patch'] } },
  },
  // The commit list, so the graph can tell a one-commit push from a five-commit
  // one. Without it `pr_get_diff_since` narrows the review with no way for
  // anything downstream to notice it narrowed too far.
  pr_list_commits: {
    entityType: 'PullRequest',
    candidates: { github: ['pull_request_read'] },
    identity: {
      github: (rec) => {
        const or = githubOwnerRepo(rec); const n = prNumber(rec);
        return or && n ? { ...or, pullNumber: n } : null;
      },
    },
    method: { github: { arg: 'method', values: ['get_commits'] } },
    skipHosts: {
      gitlab: 'GitLab resolves the incremental diff to the whole merge request, '
        + 'so there is no narrower scope for a commit list to qualify.',
    },
  },
  // ── What the reviewer already said ─────────────────────────────────────
  //
  // Distinct from `pr_list_comments`, which is the CONVERSATION (GitHub's
  // `get_comments` — issue-style comments with no file, no line, no state).
  // Prior findings live in review THREADS, and only this method returns them:
  // verified live against a real pull request, the response is
  // `review_threads[]` with `is_resolved`, `is_outdated`, `is_collapsed` and
  // each thread's comments carrying `path`, `line`, `body`, `author`.
  //
  // Those two booleans are the whole reason to prefer it. `is_resolved` is a
  // HUMAN having dealt with the finding; `is_outdated` is the anchored code
  // having changed underneath it. Both are GitHub's own state, computed by the
  // host — which is why the design carries state as resolution rather than as
  // remembered text. An agent that can read them does not need to guess whether
  // it already said something, and does not need a private notion of
  // "already said" that could disagree with what the PR actually shows.
  //
  // Left as a separate op rather than re-pointing `pr_list_comments`: that op
  // is in live graphs, and changing which method an existing op resolves to
  // would change their behaviour silently. Additive here, chosen deliberately
  // by whoever authors the graph.
  pr_list_review_threads: {
    entityType: 'PullRequest',
    candidates: {
      github: ['pull_request_read'],
      // GitLab's notes carry `resolved` / `resolvable` on discussions, so the
      // same question is answerable there through the notes function.
      gitlab: ['get_merge_request_notes'],
    },
    identity: {
      github: (rec) => {
        const or = githubOwnerRepo(rec); const n = prNumber(rec);
        return or && n ? { ...or, pullNumber: n } : null;
      },
      gitlab: (rec) => {
        const p = gitlabProject(rec); const n = prNumber(rec);
        return p && n ? { ...p, merge_request_iid: n } : null;
      },
    },
    method: { github: { arg: 'method', values: ['get_review_comments'] } },
  },
  pr_list_comments: {
    entityType: 'PullRequest',
    candidates: {
      gitlab: ['get_merge_request_notes'],
      github: ['pull_request_read'],
    },
    identity: {
      github: (rec) => {
        const or = githubOwnerRepo(rec); const n = prNumber(rec);
        return or && n ? { ...or, pullNumber: n } : null;
      },
      gitlab: (rec) => {
        const p = gitlabProject(rec); const n = prNumber(rec);
        return p && n ? { ...p, merge_request_iid: n } : null;
      },
    },
    method: { github: { arg: 'method', values: ['get_comments', 'comments', 'get_review_comments'] } },
  },
  // ── The review flow ────────────────────────────────────────────────────
  //
  // A review is ONE artifact carrying many line-anchored comments. Posting the
  // findings as loose conversation comments is not the same thing: it leaves
  // several reviews and stray comments where the role's own rule asks for one
  // summary per pull request.
  //
  // GitHub models this as a draft: open a pending review, attach comments to
  // it, then publish them together. `pr_review_begin`/`publish` are NOT an
  // approval gate — they are the container's lifecycle, and the container is
  // precisely what makes N findings arrive as one review.
  //
  // GitLab has no draft: a note posts immediately. So both bracket operations
  // SKIP there, and one host-agnostic graph runs on either host. The visible
  // difference — GitLab publishes each note as it is written, GitHub publishes
  // them at the end — is a property of the hosts, stated here rather than
  // hidden behind a lowest-common-denominator that would degrade GitHub.
  pr_review_begin: {
    entityType: 'PullRequest',
    candidates: { github: ['pull_request_review_write'] },
    identity: {
      github: (rec) => {
        const or = githubOwnerRepo(rec); const n = prNumber(rec);
        return or && n ? { ...or, pullNumber: n } : null;
      },
    },
    method: { github: { arg: 'method', values: ['create'] } },
    skipHosts: { gitlab: 'GitLab posts notes directly; there is no draft review to open.' },
  },
  pr_review_comment: {
    entityType: 'PullRequest',
    candidates: {
      // Requires the pending review pr_review_begin opened. Its own required
      // args (path, subjectType) come from the step, which is the only party
      // that knows WHICH line the finding is about.
      github: ['add_comment_to_pending_review'],
      gitlab: ['create_merge_request_note'],
    },
    identity: {
      github: (rec) => {
        const or = githubOwnerRepo(rec); const n = prNumber(rec);
        return or && n ? { ...or, pullNumber: n } : null;
      },
      gitlab: (rec) => {
        const p = gitlabProject(rec); const n = prNumber(rec);
        return p && n ? { ...p, merge_request_iid: n } : null;
      },
    },
  },
  pr_review_publish: {
    entityType: 'PullRequest',
    candidates: { github: ['pull_request_review_write'] },
    identity: {
      github: (rec) => {
        const or = githubOwnerRepo(rec); const n = prNumber(rec);
        return or && n ? { ...or, pullNumber: n } : null;
      },
    },
    method: { github: { arg: 'method', values: ['submit_pending'] } },
    skipHosts: { gitlab: 'GitLab notes are already public when written; there is nothing to publish.' },
  },
  pr_add_comment: {
    entityType: 'PullRequest',
    candidates: {
      gitlab: ['create_merge_request_note'],
      // Ordered by intent: add_issue_comment posts to the PR conversation,
      // which is what a review note means here; add_comment_to_pending_review
      // attaches to a pending review thread that may not exist.
      github: ['add_issue_comment', 'add_comment_to_pending_review'],
    },
    identity: {
      // GitHub treats a PR as an issue for conversation comments, so the
      // argument is issue_number even though the record is a pull request.
      github: (rec) => {
        const or = githubOwnerRepo(rec); const n = prNumber(rec);
        return or && n ? { ...or, issue_number: n } : null;
      },
      gitlab: (rec) => {
        const p = gitlabProject(rec); const n = prNumber(rec);
        return p && n ? { ...p, merge_request_iid: n } : null;
      },
    },
  },
};

export type TriggerBoundResolution =
  | { kind: 'not_applicable' }
  | {
      kind: 'resolved';
      toolName: string;
      from: string;
      host: string;
      /** Identity arguments the runtime built for this host. Merged OVER the
       *  step's authored input, which carries only semantics (a comment body). */
      args: Record<string, unknown>;
    }
  /** This host needs no such call. The step is a no-op and the run continues.
   *
   *  Hosts model a review differently and the graph should not have to. GitHub
   *  batches inline comments into a pending review that is created and then
   *  submitted; GitLab posts each note directly and has no draft to open or
   *  publish. Expressed as a skip, one host-agnostic graph — begin, comment,
   *  publish — runs correctly on both, instead of the distiller having to know
   *  which host will fire, which is the whole thing trigger-bound steps exist
   *  to avoid.
   *
   *  Distinct from `error` on purpose: a refusal stops the run, and "this host
   *  does not need this call" is not a failure. Distinct from silently
   *  resolving to nothing, because the log line has to say a step was skipped
   *  and why. */
  /** `host` is absent when the run had no triggering connector at all, so
   *  there was never a host to name. */
  | { kind: 'skip'; host?: string; reason: string }
  /** The operation names a real tool on the triggering host, but there is no
   *  event record to address it with. A run must treat this as an error; a
   *  static checker should treat the NAME as resolved, because that is the only
   *  half it can judge. */
  | { kind: 'resolvable'; toolName: string; from: string; host: string }
  | { kind: 'error'; reason: string };

/** A catalog entry as the validation list carries it. */
export interface CatalogTool {
  name: string;
  input_schema?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
}

/** The alias half of an `alias__function` tool name. */
function aliasOf(toolName: string): string | null {
  const i = toolName.indexOf('__');
  return i <= 0 ? null : toolName.slice(0, i);
}

/**
 * Resolve a `trigger__<op>` step against the run's trigger and live catalog.
 *
 * `triggerSource` is the connector TYPE that woke the run
 * (ConnectorEventTrigger.source). `catalog` is the set of tool names actually
 * available to this run — the same set the graph validator checks against, so a
 * resolution can never name a tool the run could not have called anyway.
 */
export function resolveTriggerBoundTool(
  toolName: string,
  triggerSource: string | undefined,
  catalog: ReadonlySet<string> | readonly CatalogTool[],
  record?: TriggerEntityRecord,
): TriggerBoundResolution {
  const tools: readonly CatalogTool[] = Array.isArray(catalog)
    ? catalog
    : [...(catalog as ReadonlySet<string>)].map((n) => ({ name: n }));
  const names = new Set(tools.map((t) => t.name));
  const alias = aliasOf(toolName);
  if (alias !== TRIGGER_ALIAS) return { kind: 'not_applicable' };

  const op = toolName.slice(TRIGGER_ALIAS.length + 2);
  const spec = CANONICAL_OPS[op];
  if (!spec) {
    return {
      kind: 'error',
      reason:
        `step names "${toolName}", but "${op}" is not a canonical operation. ` +
        `Known operations: ${Object.keys(CANONICAL_OPS).join(', ')}.`,
    };
  }

  // A trigger-bound step is meaningless without a connector-backed trigger:
  // there is no host to resolve to. Cron and manual runs land here.
  //
  // A SKIP, not an error. This used to fail the whole run, which made one
  // trigger-bound step anywhere in a graph enough to make the ENTIRE graph
  // event-only: the same workflow could no longer be fired on a schedule or by
  // hand, and it stopped at step zero rather than running the parts that had
  // nothing to do with the trigger.
  //
  // Skipping is the same answer this function already gives for "this host does
  // not need that call", and it is right for the same reason: the step cannot
  // run, the rest of the graph can, and the run should say which steps did not
  // happen rather than refuse to start.
  if (!triggerSource) {
    return {
      kind: 'skip',
      reason:
        `step names "${toolName}", which resolves against the connector that triggered the run, ` +
        `and this run has no connector event trigger — so there is no host to address. Skipped; ` +
        `the rest of the graph is unaffected.`,
    };
  }

  const host = triggerSource.trim().toLowerCase();

  // Unnecessary, not unavailable — checked BEFORE candidates so a host that was
  // never going to need this call is not reported as missing a tool.
  const skipReason = spec.skipHosts?.[host];
  if (skipReason) return { kind: 'skip', host, reason: skipReason };

  const candidates = spec.candidates[host];
  if (!candidates || candidates.length === 0) {
    return {
      kind: 'error',
      reason:
        `run was triggered by "${host}", but "${op}" declares no operation for that host. ` +
        `Declared for: ${Object.keys(spec.candidates).join(', ') || '(none)'}.`,
    };
  }

  // Candidate names are matched against the host's aliases in the LIVE catalog.
  // Alias form is `<type-with-dashes>-<connectorId first 8>`, so the host's
  // aliases are those whose leading segment matches the trigger source.
  const hostPrefix = `${host.replace(/_/g, '-')}-`;
  const matches: string[] = [];
  for (const name of names) {
    const a = aliasOf(name);
    if (!a || !a.startsWith(hostPrefix)) continue;
    const fn = name.slice(a.length + 2);
    if (candidates.includes(fn)) matches.push(name);
  }

  // Several candidate NAMES matching is preference, not ambiguity: the list is
  // ordered intent, so the earliest one present wins. Several connector
  // INSTANCES matching is genuine ambiguity and is refused below, because
  // choosing one would act on an arbitrary repository.
  const aliases = new Set(matches.map((m) => aliasOf(m)));
  if (aliases.size === 1 && matches.length >= 1) {
    const alias = [...aliases][0]!;
    for (const fn of candidates) {
      const preferred = `${alias}__${fn}`;
      if (!matches.includes(preferred)) continue;

      // ── Identity arguments ──────────────────────────────────────────
      // Built here, never authored. The distiller cannot write them: it does
      // not know which host will fire, and the arguments are host-shaped.
      const build = spec.identity[host];
      if (!build) {
        return {
          kind: 'error',
          reason:
            `run was triggered by "${host}" and "${op}" resolved to ${preferred}, but no ` +
            `identity mapping is declared for that host, so the call could not be addressed.`,
        };
      }
      if (!record) {
        // The NAME resolved; only the addressing could not be judged.
        //
        // Two different questions live in this function. "Does this operation
        // exist as a real tool on the host that fired?" is answerable from the
        // catalog alone. "Which entity does this call address?" needs the record
        // the event carried. A RUN needs both and treats this as an error, below
        // — dispatching half-addressed is the failure this mechanism exists to
        // prevent. A PRE-FLIGHT check has no event by construction and can only
        // ever ask the first, so collapsing the two made every trigger-bound
        // step unresolvable to the audit, permanently, for a reason
        // that says nothing about the workflow.
        return { kind: 'resolvable', toolName: preferred, from: toolName, host };
      }
      const identity = build(record);
      if (!identity) {
        return {
          kind: 'error',
          reason:
            `run was triggered by "${host}" and "${op}" resolved to ${preferred}, but the ` +
            `event record does not carry what that host needs to address the entity ` +
            `(repository="${String(record.repository ?? '')}", ` +
            `repositoryId="${String(record.repositoryId ?? '')}", ` +
            `number="${String(record.number ?? '')}", ` +
            // The incremental ops fail on `after`, not on the repository or the
            // number, and those three read perfectly fine when they do. Without
            // this an operator sees a fully-addressed record refused for no
            // visible reason.
            `after="${String(record.after ?? '')}"). Refusing to call it half-addressed.`,
        };
      }

      // ── Closed-set argument, verified against the live schema ───────
      // GitHub's pull_request_read is one tool serving several operations
      // behind a required `method`. The legal values are the vendor's, so they
      // are CHECKED against the schema this run actually holds rather than
      // trusted — the same rule that caught `get_pull_request` not existing.
      const binding = spec.method?.[host];
      if (binding) {
        const tool = tools.find((t) => t.name === preferred);
        const schema = (tool?.input_schema ?? tool?.inputSchema ?? {}) as {
          properties?: Record<string, { enum?: unknown[] }>;
        };
        const declared = schema.properties?.[binding.arg]?.enum;
        if (Array.isArray(declared) && declared.length > 0) {
          const legal = declared.map(String);
          const chosen = binding.values.find((v) => legal.includes(v));
          if (!chosen) {
            return {
              kind: 'error',
              reason:
                `"${op}" needs ${preferred}'s "${binding.arg}" argument, but none of the ` +
                `values it knows (${binding.values.join(', ')}) is legal here — the tool ` +
                `declares ${legal.join(', ')}. Refusing to guess which one means "${op}".`,
            };
          }
          identity[binding.arg] = chosen;
        } else if (schema.properties && binding.arg in schema.properties) {
          // Declared but open-set: take the preferred value, since there is no
          // enum to contradict it.
          identity[binding.arg] = binding.values[0];
        } else {
          return {
            kind: 'error',
            reason:
              `"${op}" expects ${preferred} to take a "${binding.arg}" argument and its ` +
              `schema does not declare one. The tool's surface has changed; refusing to ` +
              `call it with an argument it may not accept.`,
          };
        }
      }

      return { kind: 'resolved', toolName: preferred, from: toolName, host, args: identity };
    }
  }
  if (matches.length === 0) {
    return {
      kind: 'error',
      reason:
        `run was triggered by "${host}" and the step needs "${op}", but none of that host's ` +
        `tools in this run's catalog match any known name for it ` +
        // Deliberately does NOT say the host's tool surface changed. That was
        // the wording, and it named a cause this function cannot observe: the
        // catalog is empty just as often because asking the vendor FAILED, and
        // an operator sent to look for a renamed GitHub tool was reading about
        // an HTTP 502. A tool list is now kept per connector instance and
        // served when a probe fails, so reaching here means the surface really
        // was read and really lacks the operation.
        `(looked for: ${candidates.join(', ')}). ` +
        `Refusing to guess: calling the wrong operation on the right host reads as success.`,
    };
  }
  // Several distinct connector INSTANCES of the same host, or several candidate
  // names present at once. Both are ambiguous and both are refused: picking one
  // would silently act on an arbitrary repository.
  return {
    kind: 'error',
    reason:
      `run was triggered by "${host}" and the step needs "${op}", but tools from ` +
      `${aliases.size} different connector instances match: ${matches.sort().join(', ')}. ` +
      `Refusing to pick one — that would act on an arbitrary repository.`,
  };
}
