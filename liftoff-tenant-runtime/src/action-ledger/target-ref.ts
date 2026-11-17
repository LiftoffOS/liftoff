// What thing did this action act on?
//
// WHY THIS EXISTS
// ───────────────
// Every cron-triggered agent that polls a list and acts on items needs to know
// whether it has already handled a given item. Have I reviewed this PR? Replied
// to this ticket? Contacted this lead? Created this row? The `actions` table has
// held a `target_ref` column since migration 001 precisely so that question
// could be answered, and until now it answered nothing, because every write site
// filled it the same way:
//
//     targetRef: input.payload?.id || input.payload?.targetRef || ''
//
// Real tool payloads do not carry `id`, so almost no row had a usable
// target_ref and no write did. A Slack send is `{channel, text}`, so every
// one recorded `''`. Gmail is `{thread_id}`. Sheets is `{spreadsheet_id}`.
// GitHub is `{owner, repo, pull_number}`. A lucky `payload.id` catches none of
// them.
//
// The sandbox-MCP write site could even store the literal string `"null"` —
// `String(null)` reaching a database column. Deriving through here removes
// that shape entirely: an absent value yields `''`, never `"null"`.
//
// WHY NOT SHIP THE LOOKUP FIRST. A "have I acted on this?" tool answering from
// barely-populated data would tell an agent "no" for work it had certainly done,
// and the agent would do it again — which is the concrete failure this whole
// area exists to stop. A confident wrong answer is worse than no answer, so the
// data has to be real before anything reads it.
//
// SHAPE OF THE KEY
// ────────────────
// `<connector-type>:<path>`, e.g.
//
//     slack:C01ABCD2EFG
//     github:acme/billing#17
//     google-mail:thread/a239502b68ecd7f7
//
// Type, not alias. The `connector` column holds the tenant's connector INSTANCE
// alias (`slack-d77db9a0`, `google-mail-14a82d9e`), so keying on it would make
// the same PR look like a different thing after a reconnect mints a new
// connector id. `connectorTypeFromAlias` strips the instance suffix.
//
// VERSION IS A SEPARATE DIMENSION
// ───────────────────────────────
// "Have I reviewed PR #29" is the wrong question; "have I reviewed PR #29 at
// head sha a450b99" is the right one. The moment someone pushes a commit the
// previous answer stops being true. So a revision the payload names is returned
// alongside the ref rather than encoded into it — encoding would destroy the
// stable entity identity, and "everything I have ever done to this PR" is a
// question worth keeping askable.
//
// WHAT THIS CANNOT DO. A create has no pre-existing identity: `send_message
// {channel, text}` targets the CHANNEL, so the ledger can answer "have I posted
// in #code-reviewer" and cannot answer "have I posted this particular text".
// That is a property of creates, not a gap to paper over, and the lookup's
// description says so rather than implying otherwise.

import { createHash } from 'crypto';
import { tokenizeToolName } from '../agent-execution/adapter/vendor-mcp-classify';

/** How the ref was arrived at. Carried so a caller can log the gap — and so a
 *  test can assert a rule fired rather than the fallback quietly matching. */
export type TargetBasis = 'connector_rule' | 'generic_id' | 'none';

export interface DerivedTarget {
  /** Canonical `<type>:<path>`. Empty string when nothing in the payload names
   *  a thing — never `'null'`, never `'unknown'`. `actions.target_ref` is NOT
   *  NULL, and a sentinel that looks like a value is how `"null"` got stored. */
  ref: string;
  /** The revision this action applied to, when the payload names one. */
  version: string | null;
  basis: TargetBasis;
}

export const EMPTY_TARGET: DerivedTarget = { ref: '', version: null, basis: 'none' };

/** `actions.target_ref` is VARCHAR(255). Longer keys are truncated with a
 *  deterministic suffix rather than cut, so two long-but-different targets stay
 *  different — a plain slice would silently merge them. */
const MAX_REF = 255;

/** A connector INSTANCE alias is `<type>-<first 8 of the connector uuid>`. */
const INSTANCE_SUFFIX = /-[0-9a-f]{8}$/;

/**
 * `slack-d77db9a0` → `slack`, `google-mail-14a82d9e` → `google-mail`,
 * `atlassian_jira` → `atlassian-jira`, `github` → `github`.
 *
 * Runtime pseudo-connectors (`__builtin:search`, `agent_slack`) are returned
 * normalized but otherwise untouched — they have no instance suffix to strip.
 */
export function connectorTypeFromAlias(connector: string): string {
  const raw = (connector ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('__builtin:')) return raw;
  return raw.toLowerCase().replace(/_/g, '-').replace(INSTANCE_SUFFIX, '');
}

type Payload = Record<string, unknown> | null | undefined;

/** First key holding a usable scalar. Numbers count — `pull_number` is a
 *  number — but `null`, `undefined`, `''` and objects do not. */
function pick(payload: Payload, keys: readonly string[]): string | null {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Revisions a payload can name. Deliberately narrow: a field that merely
 *  CHANGES with the entity (`updated_at`, `modified`) is a value being written,
 *  not the revision being written against, and treating one as a version would
 *  make every write look like it targeted a new revision.
 *
 *  ORDER MATTERS, and `original_commit_id` leads for a reason.
 *
 *  On GitHub a review's and a review comment's `commit_id` is RESOLVED AT READ
 *  TIME: it answers "where does this land on the branch as it stands now",
 *  which is what GitHub needs to render a comment against the current diff, and
 *  it follows every push. `original_commit_id` is pinned to what was actually
 *  being looked at when the comment was written.
 *
 *  Reviews submitted while one commit was the only commit on the branch, read
 *  back after further pushes, report the head as `commit_id` on every inline
 *  comment, while `original_commit_id` still names the reviewed commit. The
 *  reviews themselves can split: COMMENTED ones still reading the original
 *  commit while APPROVED ones have moved to the head — so sampling only the
 *  COMMENTED ones makes `commit_id` look like stable provenance, which is
 *  exactly the wrong conclusion.
 *
 *  A version key is the dedupe discriminator: `findCompletedDuplicate` matches
 *  on (target_ref, target_version). Keying on a value that moves with the
 *  branch means two runs against the SAME code can record different versions —
 *  the guard stops matching, and duplicate reviews come back, which is the
 *  defect this ledger exists to prevent. So when a payload carries both, the
 *  pinned one wins.
 *
 *  For attributing work to the code it was done against, use
 *  `original_commit_id`, or compare `submitted_at` to the commit list. Never a
 *  review's or a comment's `commit_id`. */
const VERSION_KEYS = [
  'original_commit_id', 'originalCommitId',
  'commit_id', 'commitId', 'head_sha', 'headSha', 'commit_sha', 'commitSha',
  'etag', 'if_match', 'ifMatch',
  'version_token', 'versionToken', 'version', 'revision_id', 'revisionId', 'revision',
] as const;

/** Identifiers of the CALLER or the CONNECTION rather than of the thing acted
 *  on. `user_id` is the Composio account on a Gmail call, not the recipient;
 *  using it as a target would make every Gmail action collapse onto one key. */
const NON_TARGET_KEYS = new Set([
  'user_id', 'userid', 'tenant_id', 'tenantid', 'agent_id', 'agentid',
  'connector_id', 'connectorid', 'connection_id', 'connectionid',
  'session_id', 'sessionid', 'trace_id', 'traceid', 'request_id', 'requestid',
  'workflow_id', 'workflowid', 'task_id', 'taskid', 'client_id', 'clientid',
  'account_id', 'accountid', 'idempotency_key', 'idempotencykey',
  'instruction_version', 'thread_id_of_caller',
]);

/** Ordered generic identifiers, most specific first. */
const GENERIC_ID_KEYS = [
  'target_ref', 'targetRef',
  'id', 'entity_id', 'entityId', 'record_id', 'recordId',
  'object_id', 'objectId', 'resource_id', 'resourceId',
  'external_id', 'externalId', 'uid', 'uuid', 'key', 'slug',
] as const;

interface RuleResult {
  path: string;
  /** Overrides the generic version scan when a connector knows better — GitHub
   *  needs `sha` read as identity on a commit and as version on a review. */
  version?: string | null;
}

type Rule = (payload: Payload, ctx: { actionType: string; entityType: string }) => RuleResult | null;

const githubLikeSlug = (p: Payload): string | null => {
  const owner = pick(p, ['owner', 'org', 'organization', 'owner_login', 'namespace']);
  const repo = pick(p, ['repo', 'repository', 'repo_name', 'repoName', 'project']);
  if (owner && repo) return `${owner}/${repo}`;
  // `full_name` / `path_with_namespace` already carry `owner/repo`.
  return pick(p, ['repository_full_name', 'repo_full_name', 'full_name', 'path_with_namespace']);
};

/** The pseudo-connector a capability dispatch is recorded under. Not a
 *  connector type the schema cache knows; a ledger-only namespace. */
export const CAPABILITY_CONNECTOR = 'capability';

const RULES: Record<string, Rule> = {
  // {channel, text} for a send; {channel, ts} for a message read. A reply
  // targets the THREAD, which is what `thread_ts` names — so "have I replied in
  // this thread" is answerable while "have I sent this exact text" is not.
  slack: (p) => {
    const channel = pick(p, ['channel', 'channel_id', 'channelId', 'conversation_id', 'conversationId']);
    const ts = pick(p, ['thread_ts', 'threadTs', 'ts', 'message_ts', 'messageTs', 'timestamp']);
    if (channel && ts) return { path: `${channel}/${ts}` };
    if (channel) return { path: channel };
    const user = pick(p, ['user', 'username']);
    return user ? { path: `user/${user}` } : null;
  },

  github: (p) => {
    const slug = githubLikeSlug(p);
    const number = pick(p, [
      'pull_number', 'pullNumber', 'pr_number', 'prNumber',
      'issue_number', 'issueNumber', 'discussion_number', 'number',
    ]);
    // A sha is the VERSION of a numbered thing and the IDENTITY of a bare
    // commit. Reading it the same way in both places is how "reviewed PR #29"
    // and "looked at commit abc" would end up sharing a key.
    //
    // `original_commit_id` first, for the reason set out on VERSION_KEYS: a
    // GitHub review's `commit_id` is resolved at READ time and follows the
    // branch head, so keying the dedupe discriminator on it lets two runs
    // against the same code record different versions.
    const sha = pick(p, [
      'original_commit_id', 'originalCommitId',
      'commit_id', 'commitId', 'head_sha', 'headSha', 'commit_sha', 'sha',
    ]);
    if (slug && number) {
      // A LINE-ANCHORED COMMENT ACTS ON THE LINE, NOT ON THE PULL REQUEST.
      //
      // Collapsing both onto `slug#number` made two genuinely different things
      // share a key: a review that comments on ten lines targeted the same
      // thing ten times, while two PR-level summaries — the case worth
      // catching — were indistinguishable from it. The anchor is in the
      // payload, so it belongs in the key.
      //
      // The pull-request-level target is unchanged, which is what keeps two
      // summaries colliding however differently each is worded.
      //
      // This also makes "have I already posted this comment on this line"
      // answerable, where before only "have I touched this PR" was.
      const file = pick(p, ['path', 'file_path', 'filePath']);
      if (file) {
        const line = pick(p, [
          'line', 'start_line', 'startLine', 'position', 'original_line', 'originalLine',
        ]);

        // AN ANCHORED COMMENT IS IDENTIFIED BY WHERE IT IS *AND* BY WHAT IT SAYS.
        //
        // The body used to be digested into the file-level ref and not the
        // line-level one, on the assumption that a line is discriminating
        // enough. It is not, and the assumption only becomes load-bearing once
        // the duplicate guard actually runs: one run can post several DIFFERENT
        // findings on one line — say a blocking correctness note, an
        // integrity-hash note and a configurability note on
        // `package-lock.json:3221`. Keyed on the line alone, two of those three
        // are refused as repeats of the first and the review loses them.
        //
        // The reasoning already written for the file level is what settles it:
        // the body is the finding, two comments saying the same thing on the
        // same anchor ARE the duplicate this guard exists to stop, and two
        // saying different things are not. A line is a narrower anchor than a
        // file, not a different kind of thing.
        //
        // THE PULL-REQUEST-LEVEL TARGET IS DELIBERATELY UNCHANGED. Two summary
        // reviews carry no anchor, collapse onto `slug#number`, and the second
        // is still refused however differently it is worded — which is the case
        // worth catching and the one a payload hash could never catch.
        //
        // Cross-run "have I commented on this line" is the cost, and it is
        // priced knowingly: that is `have_i_acted_on`'s question, it is asked at
        // pull-request level by every caller the tool documents, and the file
        // level gave the same answer up the same way.
        const body = pick(p, ['body', 'message', 'text']);
        const digest = body ? bodyDigest(body) : null;
        if (line) {
          return {
            path: `${slug}#${number}:${file}:${line}${digest ? `@${digest}` : ''}`,
            version: sha,
          };
        }

        // A FILE-LEVEL COMMENT IS IDENTIFIED BY WHAT IT SAYS.
        //
        // With no line there is nothing else to tell two of them apart, so both
        // collapse onto `slug#number:file` — and the duplicate guard, which
        // matches (trace_id, target_ref, action_type), refuses the second as a
        // repeat of the first. Two different findings in one file, one posted.
        //
        // That was rare while only a model choosing `subjectType: 'file'` could
        // reach it. It stopped being rare when a refused line anchor started
        // falling back to file level (review-comment-anchor.ts): a review whose
        // anchors are all slightly wrong downgrades every finding in a file onto
        // one key, and keeps exactly one.
        //
        // The body is the finding. Two comments saying the same thing on the
        // same file ARE the duplicate this guard exists to stop; two saying
        // different things are not, and only the text distinguishes them.
        // Digested rather than embedded so the ref stays a key and not a copy of
        // the comment.
        return {
          path: `${slug}#${number}:${file}${digest ? `@${digest}` : ''}`,
          version: sha,
        };
      }
      return { path: `${slug}#${number}`, version: sha };
    }
    if (slug && sha) return { path: `${slug}@${sha}`, version: null };
    const path = pick(p, ['path', 'file_path', 'filePath']);
    if (slug && path) return { path: `${slug}:${path}` };
    if (slug) return { path: slug };
    // A code search is a query, not an entity — a `github search {query}` row
    // names no target, and inventing one would make every search look like the
    // same action.
    return null;
  },

  gitlab: (p) => {
    const slug = githubLikeSlug(p) ?? pick(p, ['project_id', 'projectId']);
    const iid = pick(p, ['merge_request_iid', 'mergeRequestIid', 'issue_iid', 'issueIid', 'iid']);
    if (slug && iid) return { path: `${slug}!${iid}` };
    return slug ? { path: slug } : null;
  },

  'google-mail': (p, ctx) => {
    const explicitThread = pick(p, ['thread_id', 'threadId']);
    if (explicitThread) return { path: `thread/${explicitThread}` };
    const message = pick(p, ['message_id', 'messageId']);
    if (message) return { path: `message/${message}` };
    // A bare `id` is a thread on a thread verb and a message otherwise —
    // both shapes occur (`get_thread {id}`, `read_thread {id}`).
    const bare = pick(p, ['id']);
    if (bare) {
      return { path: `${tokenizeToolName(ctx.actionType).includes('thread') ? 'thread' : 'message'}/${bare}` };
    }
    // A NEW EMAIL IS IDENTIFIED BY WHO IT GOES TO AND WHAT IT IS ABOUT.
    //
    // A send that starts a conversation names no thread and no message, so
    // without this it had no target at all and the duplicate guard could not
    // see it. The recipient is the email counterpart of a Slack channel; the
    // subject is what tells two emails to the same person apart, the way a
    // comment body tells two findings on one file apart. Digested rather than
    // embedded so the ref stays a key. The body is deliberately NOT part of
    // the identity: a repeat is recomposed, and two emails to one person under
    // one subject in one run are the same act however the wording differs.
    return mailRecipients(p, (to) => `to/${to}`);
  },

  'google-calendar': (p) => {
    const event = pick(p, ['event_id', 'eventId']);
    const calendar = pick(p, ['calendar_id', 'calendarId']) ?? (event ? 'primary' : null);
    if (calendar && event) return { path: `${calendar}/${event}` };
    return calendar ? { path: calendar } : null;
  },

  'google-sheets': (p) => {
    const spreadsheet = pick(p, ['spreadsheet_id', 'spreadsheetId']);
    if (!spreadsheet) return null;
    // Sheet name, not range: a range is where in the sheet the write landed,
    // and keying on it would make every append a brand-new target.
    const sheet = pick(p, ['sheet_name', 'sheetName', 'sheet_id', 'sheetId', 'worksheet']);
    return { path: sheet ? `${spreadsheet}/${sheet}` : spreadsheet };
  },

  'google-drive': (p) => {
    const file = pick(p, ['file_id', 'fileId', 'document_id', 'documentId']);
    return file ? { path: file } : null;
  },

  'google-docs': (p) => {
    const doc = pick(p, ['document_id', 'documentId', 'file_id', 'fileId']);
    return doc ? { path: doc } : null;
  },

  'atlassian-jira': (p) => {
    const issue = pick(p, ['issue_key', 'issueKey', 'issue_id_or_key', 'issueIdOrKey', 'issue_id', 'issueId']);
    if (issue) return { path: issue };
    const project = pick(p, ['project_key', 'projectKey', 'project_id', 'projectId']);
    return project ? { path: `project/${project}` } : null;
  },

  linear: (p) => {
    const issue = pick(p, ['issue_id', 'issueId', 'issue_identifier', 'identifier']);
    if (issue) return { path: issue };
    const team = pick(p, ['team_id', 'teamId']);
    return team ? { path: `team/${team}` } : null;
  },

  notion: (p) => {
    const page = pick(p, ['page_id', 'pageId']);
    if (page) return { path: `page/${page}` };
    const database = pick(p, ['database_id', 'databaseId']);
    if (database) return { path: `database/${database}` };
    const block = pick(p, ['block_id', 'blockId']);
    return block ? { path: `block/${block}` } : null;
  },

  salesforce: (p) => {
    const object = pick(p, ['sobject', 'sobject_type', 'object_type', 'objectType', 'entity']);
    const record = pick(p, ['record_id', 'recordId', 'sobject_id', 'id']);
    if (object && record) return { path: `${object}/${record}` };
    return record ? { path: record } : null;
  },

  hubspot: (p) => {
    const object = pick(p, ['object_type', 'objectType', 'object_name']);
    const record = pick(p, [
      'object_id', 'objectId', 'record_id', 'recordId',
      'contact_id', 'contactId', 'deal_id', 'dealId', 'company_id', 'companyId', 'id',
    ]);
    if (object && record) return { path: `${object}/${record}` };
    return record ? { path: record } : null;
  },

  zendesk: (p) => {
    const ticket = pick(p, ['ticket_id', 'ticketId']);
    if (ticket) return { path: `ticket/${ticket}` };
    const user = pick(p, ['user_id_target', 'requester_id']);
    return user ? { path: `user/${user}` } : null;
  },

  intercom: (p) => {
    const conversation = pick(p, ['conversation_id', 'conversationId']);
    if (conversation) return { path: `conversation/${conversation}` };
    const contact = pick(p, ['contact_id', 'contactId', 'lead_id', 'leadId']);
    return contact ? { path: `contact/${contact}` } : null;
  },

  'microsoft-teams': (p) => {
    const message = pick(p, ['message_id', 'messageId']);
    const container = pick(p, ['chat_id', 'chatId', 'channel_id', 'channelId', 'team_id', 'teamId']);
    if (container && message) return { path: `${container}/${message}` };
    return container ? { path: container } : null;
  },

  'microsoft-outlook-mail': (p) => {
    const message = pick(p, ['message_id', 'messageId', 'id']);
    if (message) return { path: `message/${message}` };
    const conversation = pick(p, ['conversation_id', 'conversationId']);
    if (conversation) return { path: `conversation/${conversation}` };
    return mailRecipients(p, (to) => `to/${to}`);
  },

  // A transactional send names nothing but who it goes to and what it says.
  sendgrid: (p) => mailRecipients(p, (to) => `to/${to}`),

  // A CAPABILITY NAMES NO VENDOR, SO ITS TARGET COMES FROM THE ARGUMENTS ALONE.
  //
  // The runtime cannot know which connector a capability resolved to — the
  // handle is opaque by design — so the only identity available is the shape
  // of what the model asked for. The path is built by the SAME functions the
  // connector rules use, so an email sent through a capability and the same
  // email sent through the bound connector share a path byte for byte; the
  // operation half of the act key (see `actKeyFor`) is what keeps two
  // different capabilities with mail-shaped arguments apart.
  //
  // Anything not mail- or chat-shaped has no target and is not guessed at.
  [CAPABILITY_CONNECTOR]: (p) => {
    const mail = mailRecipients(p, (to) => `to/${to}`);
    if (mail) return mail;
    const channel = pick(p, ['channel', 'channel_id', 'channelId', 'conversation_id', 'conversationId']);
    if (!channel) return null;
    const ts = pick(p, ['thread_ts', 'threadTs', 'ts']);
    return { path: ts ? `${channel}/${ts}` : channel };
  },
};

/** The `<operation>` half of an act key for a direct connector tool: the
 *  connector TYPE (never the instance alias) and the function. */
export function directOperation(connector: string, actionType: string): string {
  return `${canonicalType(connectorTypeFromAlias(connector))}:${(actionType ?? '').trim().toLowerCase()}`;
}

/** The `<operation>` half for a capability: the vendor-neutral fingerprint the
 *  control plane minted into the handle, under the act's family when the
 *  handle names one (`cap:mail_send:<fingerprint>`). The family is what a
 *  cross-route match is decided on; a capability with none matches only its
 *  own operation. */
export function capabilityOperation(fingerprint: string, family?: string | null): string {
  return family ? `cap:${family}:${fingerprint}` : `cap:${fingerprint}`;
}

/** The content a payload would write, as a short digest, or null when the
 *  payload carries nothing to write.
 *
 *  Keys are sorted so the same content under a different key order is the same
 *  content. Volatile fields are dropped: a retry of one act re-sends its own
 *  idempotency token and its own request id, and keying on those would make
 *  every repeat look new — which is the whole failure this digest exists to
 *  catch. */
function contentFingerprint(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if (VOLATILE_PAYLOAD_KEYS.has(k.toLowerCase())) continue;
        out[k] = canonical((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  const body = JSON.stringify(canonical(payload));
  if (!body || body === '{}' || body === 'null' || body === '[]') return null;
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/** Payload fields that change between two attempts at the SAME act, so they
 *  must not enter its identity. */
const VOLATILE_PAYLOAD_KEYS = new Set([
  'idempotency_key', 'idempotencykey', 'request_id', 'requestid',
  'nonce', 'timestamp', 'client_request_id', 'clientrequestid',
]);

/**
 * The identity of the ACT, `<operation>|<target path>` — or, for an act that
 * NAMES NO TARGET, `<operation>|#<content digest>`.
 *
 * The path is `target.ref` without its connector-type prefix, so the same
 * outward act through two routes shares it while `target_ref` keeps naming the
 * thing by connector for every reader it has.
 *
 * The content form exists because an act that CREATES something has no target
 * to be keyed on — the thing does not exist yet — so every create, on every
 * connector, fell outside the duplicate guard entirely. One run dispatched the
 * identical `create_document_markdown` twice, fifteen seconds apart, from two
 * different paths (a model-issued tool call and a workflow step's synthesised
 * one). Both payloads were byte-identical, both had a null `act_key` and a null
 * `target_ref`, so nothing could see they were one act, and the person was left
 * with two documents and no way to tell which was current.
 *
 * Creating two DIFFERENT things stays two acts: the digest differs. The lookup
 * is scoped to the run, so writing the same content again next week is
 * untouched. `payload` is optional only so an unkeyed caller behaves exactly as
 * it did; a caller that wants a create deduplicated passes it at BOTH the
 * lookup and the write, or the key stored is not the key searched for.
 */
export function actKeyFor(
  operation: string,
  target: DerivedTarget,
  payload?: unknown,
): string | null {
  if (target.ref) {
    const i = target.ref.indexOf(':');
    const path = i >= 0 ? target.ref.slice(i + 1) : target.ref;
    if (path) return `${operation}|${path}`;
  }
  if (payload === undefined) return null;
  const content = contentFingerprint(payload);
  return content ? `${operation}|#${content}` : null;
}

/** True for an act key whose identity is its CONTENT rather than a target.
 *  The duplicate lookup needs to tell them apart: a target-keyed act can be
 *  compared by target alone for rows written before act keys existed, and a
 *  content-keyed one cannot be compared at all without its key. */
export function isContentActKey(actKey: string | null | undefined): boolean {
  return typeof actKey === 'string' && actKey.includes('|#');
}

/** Direct operations that ARE a mail send. A capability with a mail-shaped
 *  target is the same act as any of these on the same path; a draft or a reply
 *  is not, and is deliberately absent. Curated, not inferred. */
export const MAIL_SEND_OPERATIONS: readonly string[] = [
  'google-mail:send_email',
  'microsoft-outlook-mail:send_email',
  'sendgrid:send_email',
  'sendgrid:send_email_from_template',
];

/** The family those operations belong to — the same name the control plane
 *  mints into a capability handle for a reference in the same list. */
const MAIL_SEND_FAMILY = 'mail_send';

const MAIL_PATH = /^to\/[^|]+@[0-9a-f]{12}$/;

/**
 * Every act key that means the same act as `actKey`, for the duplicate lookup.
 *
 * `exact` always holds the key itself. A MAIL SEND — a direct operation in the
 * curated list, or a capability whose handle carries the `mail_send` family —
 * on a mail-shaped path also matches the other direct mail sends on that
 * path, and `capabilityLike` matches the other `mail_send` capabilities on it
 * (their vendor is unknown here, so they can only be matched by family and
 * path). A capability with no family, a draft, a reply: each stays its own
 * exact key. LIKE metacharacters in the path are escaped.
 */
export function equivalentActKeys(actKey: string): { exact: string[]; capabilityLike: string | null } {
  const i = actKey.indexOf('|');
  const operation = i >= 0 ? actKey.slice(0, i) : actKey;
  const path = i >= 0 ? actKey.slice(i + 1) : '';
  const isMailSend =
    MAIL_SEND_OPERATIONS.includes(operation) || operation.startsWith(`cap:${MAIL_SEND_FAMILY}:`);
  if (!path || !isMailSend || !MAIL_PATH.test(path)) return { exact: [actKey], capabilityLike: null };

  const exact = new Set<string>([actKey]);
  for (const op of MAIL_SEND_OPERATIONS) exact.add(`${op}|${path}`);
  const escaped = path.replace(/[\\%_]/g, (c) => `\\${c}`);
  return { exact: [...exact], capabilityLike: `cap:${MAIL_SEND_FAMILY}:%|${escaped}` };
}

/** The keys a recipient list arrives under. The canonical name is `to`; the
 *  vendor-shaped names are what the model uses when the schema it sees is the
 *  vendor's own (`recipient_email` on Gmail, `to_recipients` on Outlook), and
 *  the dispatcher accepts both — so the ledger must too, or the same send is
 *  keyed on one path and unkeyed on the other. */
const RECIPIENT_KEYS = [
  'to', 'recipient', 'recipients', 'recipient_email', 'recipientEmail',
  'to_email', 'toEmail', 'to_recipients', 'toRecipients',
] as const;

/**
 * `to/<recipients>@<subject digest>` for a payload that names recipients and a
 * subject, else null. Recipients arrive as one comma-separated string or as an
 * array of addresses; they are lower-cased and sorted so the same people in a
 * different order or case are the same target.
 */
function mailRecipients(p: Payload, path: (to: string) => string): RuleResult | null {
  const to = pickRecipients(p);
  const subject = pick(p, ['subject']);
  if (!to || !subject) return null;
  const recipients = to
    .map((addr) => addr.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
  if (!recipients) return null;
  return { path: `${path(recipients)}@${bodyDigest(subject)}` };
}

/** First recipient key holding a string (comma-separated) or an array of
 *  strings; an array of objects is read by its `email`/`address` field, which
 *  is how a vendor names a typed recipient. */
function pickRecipients(p: Payload): string[] | null {
  if (!p || typeof p !== 'object') return null;
  for (const key of RECIPIENT_KEYS) {
    const value = (p as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.split(',');
    if (Array.isArray(value)) {
      const addrs = value
        .map((v) => (typeof v === 'string' ? v : v && typeof v === 'object'
          ? String((v as Record<string, unknown>).email ?? (v as Record<string, unknown>).address ?? '')
          : ''))
        .filter((v) => v.trim());
      if (addrs.length > 0) return addrs;
    }
  }
  return null;
}

/** Aliases onto a canonical rule. Connector types are spelled differently by
 *  Composio, by the conflict-policy registry and by the native adapters, and a
 *  spelling this map misses degrades to the generic scan rather than failing. */
const TYPE_SYNONYMS: Record<string, string> = {
  gmail: 'google-mail',
  googlemail: 'google-mail',
  jira: 'atlassian-jira',
  'jira-cloud': 'atlassian-jira',
  atlassian: 'atlassian-jira',
  googlecalendar: 'google-calendar',
  googlesheets: 'google-sheets',
  sheets: 'google-sheets',
  googledrive: 'google-drive',
  googledocs: 'google-docs',
  outlook: 'microsoft-outlook-mail',
  'outlook-mail': 'microsoft-outlook-mail',
  teams: 'microsoft-teams',
  msteams: 'microsoft-teams',
  'agent-slack': 'slack',
  'agent-teams': 'microsoft-teams',
};

function canonicalType(type: string): string {
  return TYPE_SYNONYMS[type] ?? type;
}

/** Any `*_id` the payload carries that names a thing rather than the caller.
 *  This is what covers the long tail — there are far more connector toolkits
 *  than there will ever be hand-written rules, and a Composio tool nobody
 *  anticipated still tends to name its target `<noun>_id`. */
function genericIdScan(payload: Payload): string | null {
  const direct = pick(payload, GENERIC_ID_KEYS);
  if (direct) return direct;
  if (!payload || typeof payload !== 'object') return null;
  const candidates = Object.keys(payload)
    .filter((k) => /(_id|Id)$/.test(k) && !NON_TARGET_KEYS.has(k.toLowerCase()))
    .sort();
  for (const key of candidates) {
    const value = pick(payload, [key]);
    if (value) return `${key.replace(/(_id|Id)$/, '').toLowerCase()}/${value}`;
  }
  return null;
}

/** Keep long keys distinct. A plain slice would merge two different targets
 *  that happen to share a prefix, which is the one thing a dedup key must
 *  never do. */
/** A short, stable digest of a comment body.
 *
 *  Identity for a target that has nothing else to be identified by. Short
 *  because a target_ref is a key: the column is bounded, and the full text
 *  belongs in the action row, not in the thing that indexes it. */
function bodyDigest(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 12);
}

function fit(ref: string): string {
  if (ref.length <= MAX_REF) return ref;
  let hash = 5381;
  for (let i = 0; i < ref.length; i++) hash = ((hash * 33) ^ ref.charCodeAt(i)) >>> 0;
  const suffix = `~${hash.toString(36)}`;
  return ref.slice(0, MAX_REF - suffix.length) + suffix;
}

/**
 * Derive the canonical target of one dispatched action.
 *
 * Never throws and never invents: a payload that names nothing yields
 * `EMPTY_TARGET`, and the caller decides whether that is worth a warning. The
 * alternative — refusing the dispatch — would break every connector whose rule
 * is not yet written, which is most of them.
 */
/** Connector types whose RULE derives a revision for the thing acted on.
 *
 *  ONE, and that is the point rather than an oversight to be tidied away.
 *
 *  `hasActedOn` grades a prior action against the revision being asked about,
 *  and its most useful verdict — `acted_at_other_version`, "you did this and
 *  the thing has changed since, so do it again" — can only be reached when some
 *  recorded row carries a version. Every rule but GitHub's returns none, so for
 *  the other sixteen a version is recorded only if the tool payload happened to
 *  carry one of VERSION_KEYS. A Docs `update_document_markdown` carries
 *  document_id and markdown; a Slack post carries a channel; a Gmail send
 *  carries a thread. None of them carry an etag or a revision id.
 *
 *  So on those connectors the guard can answer `acted` or
 *  `acted_version_unknown` and nothing else, and BOTH read as "you already did
 *  this" — which is a claim about the ledger and not about the world. Delete
 *  the document the agent wrote and the ledger still says it wrote it, because
 *  a dispatch record is what it is.
 *
 *  Callers must be told which situation they are in rather than left to infer
 *  it, which is what `versionBasis` on the answer is for. Kept as an explicit
 *  list because a rule is a function and what it returns cannot be read off it
 *  statically; `__tests__/version-basis.test.ts` fails if the two drift. */
export const CONNECTOR_TYPES_DERIVING_VERSION: ReadonlySet<string> = new Set(['github']);

/** Whether this connector's rule derives a revision, given any spelling of it. */
export function connectorRuleDerivesVersion(connector: string): boolean {
  return CONNECTOR_TYPES_DERIVING_VERSION.has(canonicalType(connectorTypeFromAlias(connector)));
}

export function deriveTarget(input: {
  connector: string;
  actionType: string;
  entityType?: string;
  payload?: Payload;
  /** The revision the RUN is acting on, for payloads that cannot name one.
   *  Used ONLY when the payload named no version — a value the call itself
   *  carries is always the truer answer. See `ExecuteInput.targetVersionHint`
   *  for why a review has to be told its own head sha from outside. */
  targetVersionHint?: string | null;
}): DerivedTarget {
  const type = canonicalType(connectorTypeFromAlias(input.connector));
  if (!type || type.startsWith('__builtin:')) return EMPTY_TARGET;

  const hint = typeof input.targetVersionHint === 'string' && input.targetVersionHint.trim()
    ? input.targetVersionHint.trim()
    : null;

  const ctx = { actionType: input.actionType ?? '', entityType: input.entityType ?? '' };
  const rule = RULES[type];
  const ruled = rule ? rule(input.payload, ctx) : null;

  if (ruled?.path) {
    const version = ruled.version !== undefined ? ruled.version : pick(input.payload, VERSION_KEYS);
    return { ref: fit(`${type}:${ruled.path}`), version: version ?? hint, basis: 'connector_rule' };
  }

  const generic = genericIdScan(input.payload);
  if (generic) {
    return {
      ref: fit(`${type}:${generic}`),
      version: pick(input.payload, VERSION_KEYS) ?? hint,
      basis: 'generic_id',
    };
  }

  // No target means no version either. A revision with nothing to attach it to
  // is not a target, and returning one would make every unkeyed action in a run
  // look like the same versioned thing.
  return EMPTY_TARGET;
}

/** Verbs that change something on the far side. Used only to decide whether a
 *  missing target is worth logging — an unkeyed READ is unremarkable, an
 *  unkeyed WRITE is a rule that needs writing. */
const WRITE_TOKENS = new Set([
  'create', 'update', 'edit', 'write', 'set', 'add', 'modify', 'patch', 'put',
  'upsert', 'merge', 'insert', 'append', 'delete', 'remove', 'archive', 'close',
  'send', 'post', 'reply', 'comment', 'publish', 'share', 'assign', 'move',
  'rename', 'upload', 'invite', 'approve', 'reject', 'mark',
]);

/** Verbs that only ever LOOK. A name that leads with one of these is a read,
 *  whatever else appears later in it. */
const READ_LEAD_TOKENS = new Set([
  'get', 'list', 'read', 'fetch', 'search', 'find', 'query',
  'describe', 'show', 'view', 'download', 'export',
]);

/**
 * Does this action change something on the far side?
 *
 * ANY token used to count, which made `merge` inside a NOUN read as a verb:
 * `get_merge_request` tokenizes to [get, merge, request] and came back a WRITE.
 * The duplicate guard runs only on writes, so two reads of the same merge
 * request in one run derived the same target and the SECOND WAS REFUSED — while
 * the guard's own comment says "a read repeated in one run is wasteful, not
 * wrong, and is none of this guard's business".
 *
 * The same trap, in the same word, that `hardInvariantEffectOf` guards against:
 * `merge` as a substring also appears in `create_merge_request_note` (a comment)
 * and `create_merge_request` (which opens one). There it is handled by requiring
 * the leading verb to BE the merge.
 *
 * A pure leading-verb rule does not work here, because two genuine writes do not
 * lead with their verb: `pull_request_review_write` leads with `pull`, and
 * `squash_and_merge_pull_request` leads with `squash`. So the rule is narrower —
 * a leading READ verb wins, and everything else keeps the any-token behaviour.
 * That fixes the false positives without reclassifying a single real write.
 */
export function isWriteAction(actionType: string): boolean {
  const tokens = tokenizeToolName(actionType ?? '');
  if (tokens.length === 0) return false;
  if (READ_LEAD_TOKENS.has(tokens[0])) return false;
  return tokens.some((t) => WRITE_TOKENS.has(t));
}
