// Event Trigger Manager
// Subscribes to connector-events topic and routes events to matching agents.
// Analogous to cloud-scheduler.ts but for event-driven (push) triggers.

import { PubSub, Subscription, Message } from '@google-cloud/pubsub';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../infrastructure/logging';
import { getPool } from '../infrastructure/database';
import { normalizeIntegrationsField } from '../instruction-compiler/integration-shape';
import type { ConnectorCatalogResponse } from '@liftoffos/connector-types';
import { setCatalogTriggerDispatch, type ComposioTriggerDispatch } from './composio-trigger-registry';
import { resolveTerminalState, THREAD_STATUS_BY_TERMINAL } from '../agent-execution/terminal-state';
import { recordTriggerSkip } from './skip-reasons';
import { buildEventMessageEnvelope } from './event-input-envelope';
import { connectorEventTrigger } from '../agent-lifecycle/types';
import { getManagedSecret } from '../infrastructure/secret-store';

// Lazy imports to avoid circular dependency (agent-execution → agent-lifecycle → event-trigger)
function getAgentExecutionService() {
   
  return require('../agent-execution/service').agentExecutionService;
}
function getInvocationsService() {
   
  return require('../invocations/service').invocationsService;
}

const pubsub = new PubSub();
const environment = process.env.ENVIRONMENT || 'dev';

// In-memory registry of active event-triggered agents
// Maps eventTopic → Set of { agentId, tenantId }
const eventAgentRegistry = new Map<string, Set<string>>();

// Track subscription reference
let connectorEventsSubscription: Subscription | null = null;

// connectorType → entityType → eventTopics[]
// Loaded at startup from the connector-service catalog.
// ALL polling entries regardless of listImplemented — routes any event that arrives,
// including those from connectors not yet fully scheduled.
let routingMap: Map<string, Map<string, string[]>> = new Map();

interface EventAgentEntry {
  agentId: string;
  tenantId: string;
}

// Parse "agentId:tenantId" key
function parseKey(key: string): EventAgentEntry {
  const [agentId, tenantId] = key.split(':');
  return { agentId, tenantId };
}

/**
 * Supported Gmail query subset for event-routing filters. Each clause is
 * checked AND-style; unsupported clauses are treated as non-matching to be
 * conservative (avoid leaking unfiltered email to the agent).
 *
 * Tokens with the `key:value` shape:
 *   - `label:<name>`     → labelIds contains <name> (raw system label, e.g. INBOX)
 *   - `to:<addr>`        → To header contains <addr>
 *   - `from:<addr>`      → From header contains <addr>
 *   - `subject:<text>`   → Subject header contains <text>
 *   - `is:<state>`       → standard Gmail state: unread, read, starred, important
 *   - `has:attachment`   → message has at least one non-inline attachment
 *
 * Two payload shapes are accepted because the two delivery paths produce
 * different shapes:
 *
 *   Composio GMAIL_NEW_GMAIL_MESSAGE webhook (authoritative schema fetched
 *   from `GET /api/v3/triggers_types/GMAIL_NEW_GMAIL_MESSAGE`):
 *     { to, sender, subject, label_ids, attachment_list, payload, ... }
 *     — flat, snake_case; `sender` is the From field, `label_ids` are the
 *     Gmail system labels (INBOX, UNREAD, STARRED, IMPORTANT, …).
 *
 *   Native Gmail API v1 (used by the direct watch/history push path):
 *     { labelIds, payload: { headers: [...], parts: [...] } }
 *     — camelCase; To/From/Subject live as entries in payload.headers.
 *
 * Earlier revisions of this file only understood the Gmail API shape, so
 * every Composio-delivered event silently failed every filter (the `to:`,
 * `from:`, `subject:`, and `is:unread` clauses were comparing against
 * always-undefined fields). Normalising at the top keeps the predicate
 * loop oblivious to delivery path.
 *
 * Full Gmail query syntax is out of scope (no `OR`, no quoting, no
 * `older_than:`, no full-text search); agents that need that issue explicit
 * `list_messages` tool calls with the full Gmail-side query semantics.
 */
type GmailEventMessageInput = {
  // Composio shape (flat, snake_case)
  to?: string;
  sender?: string;
  subject?: string;
  label_ids?: string[];
  attachment_list?: unknown[];
  // Native Gmail API shape (camelCase, nested headers)
  labelIds?: string[];
  headers?: { To?: string; From?: string; Subject?: string; [k: string]: string | undefined };
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
    parts?: Array<{ filename?: string; body?: { attachmentId?: string } }>;
  };
};


/**
 * How many results to pull per question. BOTH questions below use this same
 * cap, which is what makes comparing their answers sound.
 *
 * 50 because that is the vendor's own default, so it is the widest window we
 * get for free: a larger cap only ever turns an undecidable answer into a
 * decidable one.
 */
const GMAIL_MATCH_PAGE = 50;

/**
 * Does this message match the binding's Gmail query? Asked of GMAIL.
 *
 * The query is Gmail's search language, and it was being evaluated by a
 * hand-written subset here: six operators, no negation, no booleans, and
 * `default: return false` for everything else. Meanwhile the POLLING path
 * hands the identical string to Gmail as `q` (google-mail.ts). One string, two
 * engines, and every divergence dropped customer mail silently.
 *
 * A binding of
 * `is:unread to:support@example.com -label:support/handled` matched nothing
 * at all. `-label:` split to the key `-label`, which no case handles, so every
 * inbound support email was skipped with `gmail_query_no_match`. Gmail itself
 * has understood that operator for twenty years.
 *
 * So we ask the owner of the language: run the binding query UNMODIFIED and see
 * whether this message is among the results. Negation, OR, parentheses,
 * `newer_than:` and everything Gmail adds later work by construction, with no
 * parser to keep in step.
 *
 * Identity is the GMAIL MESSAGE ID, the same `items[].id` the search returns —
 * not the RFC 5322 `Message-ID`. The first cut of this used `rfc822msgid:`, and
 * Composio's GMAIL_NEW_GMAIL_MESSAGE payload carries no headers at all
 * (`{id, message_id, thread_id, subject, sender, to, message_text, label_ids}`),
 * so that identifier does not exist on the event we are filtering. The id does,
 * it is already what `{{input.message.id}}` resolves to, and comparing it needs
 * no query composition — so a binding using OR cannot swallow an appended
 * clause, and nothing has to be escaped into Gmail's search grammar.
 *
 * FAILS OPEN. If the check cannot be made — no id, no connector, Gmail
 * unreachable, or an answer we cannot read as complete — the run proceeds.
 * Dropping a customer email to avoid running an agent once unnecessarily is the
 * wrong trade for a support inbox, and a Gmail outage that breaks this check
 * would equally break the fetch the agent needs, so refusing here buys nothing.
 */
async function gmailQueryMatchesViaGmail(args: {
  tenantId: string;
  agentId: string;
  connectorId: string;
  query: string;
  message: GmailEventMessageInput;
}): Promise<{ matched: boolean; decided: boolean; reason?: string; observed?: number }> {
  const msgId = buildEventMessageEnvelope(
    'google_mail',
    args.message as unknown as Record<string, unknown>,
  ).id;
  if (!msgId) return { matched: true, decided: false, reason: 'no_gmail_message_id' };

  try {
    const { getConnectorServiceClient } = await import('../connectors/connector-service-client');
    const client = getConnectorServiceClient();

    const ask = async (query: string): Promise<string[]> => {
      const resp = await client.execute({
        tenantContext: { tenantId: args.tenantId },
        connectorId: args.connectorId,
        functionName: 'list_messages',
        // `maxResults`, camelCase. `max_results` is accepted and SILENTLY
        // IGNORED — asked the live connector for 3 and for 7, got 50 both
        // times, which is the vendor default. A cap that does not apply is
        // worse than no cap: it reads as a bound the comparison below can rely
        // on, and it is not one.
        input: { query, maxResults: GMAIL_MATCH_PAGE } as never,
      });
      // `result`, NOT `data`. ExecuteResponse's payload field is `result`
      // (tool-gateway/service.ts maps it as `data: resp.result ?? null`, which
      // is where the wrong name came from). Reading the absent `data` yielded
      // zero items for EVERY message, so the check answered "no match" to
      // everything and every inbound support email was skipped — the exact
      // outcome the hand-written parser had produced, from a different cause.
      const result = (resp as { result?: unknown }).result as
        { items?: Array<{ id?: unknown }> } | undefined;
      const items = Array.isArray(result?.items) ? result.items : [];
      return items.map((i) => String(i?.id ?? '')).filter((id) => id.length > 0);
    };

    const filtered = await ask(args.query);
    if (filtered.includes(msgId)) return { matched: true, decided: true };

    // Absent from the filtered page — but "does not match" and "not indexed
    // yet" look identical from here, and Gmail's search index trails delivery.
    // We are called within seconds of arrival, so that gap is the common case,
    // not the rare one. Ask the SAME question with no filter.
    //
    // Equal caps are what make this exact rather than a heuristic: if the
    // message is among the newest N messages overall AND it matches the query,
    // then it is necessarily among the newest N MATCHING messages, so it would
    // have appeared in the filtered page. Present in the control and absent
    // from the filtered page can therefore only mean the query excluded it.
    // Missing from the control too means Gmail cannot see it yet, and the
    // binding has told us nothing.
    const control = await ask('');
    if (!control.includes(msgId)) {
      return { matched: true, decided: false, reason: 'message_not_yet_searchable', observed: filtered.length };
    }
    return { matched: false, decided: true, reason: 'not_in_query_results', observed: filtered.length };
  } catch (err) {
    return { matched: true, decided: false, reason: (err as Error).message };
  }
}

interface GmailBindingForAgent {
  gmailQuery?: string;
  sendAs?: string;
}

/**
 * Load the calling agent's connector binding config by connector type from
 * the local cached_internal_agents row, resolving runtime agentId →
 * internal_agent_id via the runtime mapping.
 *
 * PB's internal_agents table is NOT replicated to the tenant runtime —
 * cached_internal_agents is. The integrations JSONB lives on the cache row,
 * and the cache key is the PB-side internal_agent_id, not the runtime
 * agent_id. The mapping JOIN bridges the two. Previously this code queried
 * `FROM internal_agents` directly which exists only on platform-backend;
 * every event-routed agent fell into the catch branch with
 * `relation "internal_agents" does not exist`, and the gmailQuery /
 * outlookFilter predicate silently fell through (no filtering applied).
 *
 * Returns the connector binding's `config` object, or undefined when the
 * agent has no binding of that type. The query is idempotent and tenant-
 * scoped so the function is safe to call on the event-dispatch hot path.
 */
/**
 * The agent's binding for a connector type, WITH its connector id.
 *
 * A sibling of getAgentConnectorBindingConfig rather than a widening of it:
 * that function's contract is "the config object and nothing else", asserted
 * by its own test, and callers spread it into places where an extra key would
 * travel somewhere it was never meant to go. Delegating a query to the vendor
 * needs a connector to dispatch against, so it needs the id — and re-querying
 * for it would be a second round trip on the event hot path.
 */
export async function getAgentConnectorBinding<T extends Record<string, unknown>>(
  tenantId: string,
  agentId: string,
  connectorType: string,
): Promise<{ connectorId: string; config: T } | undefined> {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT cia.integrations
       FROM cached_internal_agents cia
       JOIN internal_agent_runtime_mapping m
         ON m.internal_agent_id = cia.internal_agent_id
        AND m.tenant_id = cia.tenant_id
       WHERE m.agent_id = $1 AND m.tenant_id = $2
       LIMIT 1`,
      [agentId, tenantId],
    );
    if (res.rowCount === 0) return undefined;
    const integrations = normalizeIntegrationsField(res.rows[0].integrations);
    const binding = integrations.find((i) => i.type === connectorType);
    if (!binding?.id) return undefined;
    return { connectorId: binding.id, config: (binding.config ?? {}) as T };
  } catch (err) {
    logger.warn('Failed to load connector binding for event filter', {
      tenantId, agentId, connectorType, err: (err as Error).message,
    });
    return undefined;
  }
}

export async function getAgentConnectorBindingConfig<T extends Record<string, unknown>>(
  tenantId: string,
  agentId: string,
  connectorType: string,
): Promise<T | undefined> {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT cia.integrations
       FROM cached_internal_agents cia
       JOIN internal_agent_runtime_mapping m
         ON m.internal_agent_id = cia.internal_agent_id
        AND m.tenant_id = cia.tenant_id
       WHERE m.agent_id = $1 AND m.tenant_id = $2
       LIMIT 1`,
      [agentId, tenantId],
    );
    if (res.rowCount === 0) return undefined;
    // Use the shared normalizer so a row written via PB's older
    // integrationId path still resolves to the right binding.
    const integrations = normalizeIntegrationsField(res.rows[0].integrations);
    const binding = integrations.find((i) => i.type === connectorType);
    return (binding?.config ?? undefined) as T | undefined;
  } catch (err) {
    logger.warn('Failed to load connector binding config for event filter', {
      tenantId,
      agentId,
      connectorType,
      err: (err as Error).message,
    });
    return undefined;
  }
}

/**
 * Gmail-specific wrapper kept for readability at the dispatch call site.
 * The underlying query is shared with the Outlook variant via
 * getAgentConnectorBindingConfig.
 */
async function getGmailBindingConfig(
  tenantId: string,
  agentId: string,
): Promise<GmailBindingForAgent | undefined> {
  return getAgentConnectorBindingConfig<GmailBindingForAgent & Record<string, unknown>>(
    tenantId,
    agentId,
    'google_mail',
  );
}

/**
 * v1 supported Microsoft Graph $filter subset for event-routing predicates,
 * all AND-composed:
 *   - from/emailAddress/address eq '<addr>'
 *   - toRecipients/any(t:t/emailAddress/address eq '<addr>')
 *   - categories/any(c:c eq '<cat>')
 * Unsupported clauses → return false (conservative).
 *
 * The Gmail equivalent of this function is GONE: its predicate is now asked of
 * Gmail (gmailQueryMatchesViaGmail above), because a hand-written subset of a
 * vendor's filter language silently drops events it cannot parse — `-label:`
 * dropped every inbound support email for a day. This one survives because
 * Graph's $filter has no delegated equivalent to ask, NOT because the approach
 * is sound. Treat a parse gap here as the same defect, and prefer widening the
 * delegation over teaching this more operators.
 *
 * TWO PAYLOAD SHAPES are accepted:
 *
 *   1. Direct Microsoft Graph subscription (full message):
 *        { from: { emailAddress: { address: '...' } },
 *          toRecipients: [...],
 *          categories: [...] }
 *
 *   2. Composio OUTLOOK_MESSAGE_TRIGGER webhook (MINIMAL — id + event_type
 *      only, verified live against
 *      `GET /api/v3/triggers_types/OUTLOOK_MESSAGE_TRIGGER`):
 *        { id: 'AAMkAG...', event_type: 'message.created' }
 *      Composio does NOT include from/toRecipients/categories in the
 *      trigger payload — the agent has to call its outlook read-message
 *      tool with the id to get the actual content.
 *
 * When we detect the Composio-minimal shape AND the binding has an
 * outlookFilter, we cannot evaluate the predicate client-side. Returning
 * false would silently drop every Composio Outlook event for any agent
 * that has a non-empty filter (the previous behaviour — every clause
 * matched against an empty/undefined field and short-circuited the
 * predicate to false).
 *
 * Fail-open with a structured warning is the contract: the agent fires,
 * then self-filters via its Outlook tools using the full message it
 * fetches on first turn. Operators see the warning and can either accept
 * the latency cost of one extra LLM turn or move the filter into the
 * agent's responsibilities/system-prompt.
 */
type OutlookEventMessage = {
  from?: { emailAddress?: { address?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  categories?: string[];
  [k: string]: unknown;
};

function isComposioMinimalOutlookShape(message: OutlookEventMessage): boolean {
  // The graph-subscription shape carries at least one of these fields when
  // a clause references them. The Composio webhook carries none of them.
  // If every field the filter could reference is absent we treat it as
  // "no client-side data to evaluate filter against".
  return (
    message.from === undefined &&
    message.toRecipients === undefined &&
    message.categories === undefined
  );
}

export function outlookEventMatches(
  filter: string | undefined,
  message: OutlookEventMessage,
): boolean {
  if (!filter) return true;

  if (isComposioMinimalOutlookShape(message)) {
    logger.warn('Outlook event arrived without filter-evaluable fields (Composio webhook shape) — bypassing client-side filter; agent must self-filter via tools', {
      outlookFilter: filter,
    });
    return true;
  }

  const clauses = filter.split(/\s+and\s+/i).map(s => s.trim()).filter(Boolean);

  for (const clause of clauses) {
    const fromEq = clause.match(/^from\/emailAddress\/address\s+eq\s+'([^']+)'$/);
    if (fromEq) {
      const addr = (message.from?.emailAddress?.address ?? '').toLowerCase();
      if (addr !== fromEq[1].toLowerCase()) return false;
      continue;
    }
    const toAny = clause.match(/^toRecipients\/any\([a-z]+:[a-z]+\/emailAddress\/address\s+eq\s+'([^']+)'\)$/);
    if (toAny) {
      const target = toAny[1].toLowerCase();
      const recipients = message.toRecipients ?? [];
      if (!recipients.some(r => (r.emailAddress?.address ?? '').toLowerCase() === target)) return false;
      continue;
    }
    const catAny = clause.match(/^categories\/any\([a-z]+:[a-z]+\s+eq\s+'([^']+)'\)$/);
    if (catAny) {
      const target = catAny[1];
      const cats = message.categories ?? [];
      if (!cats.includes(target)) return false;
      continue;
    }
    return false; // unsupported clause → conservative reject (matches gmail pattern)
  }
  return true;
}

interface OutlookBindingForAgent {
  outlookFilter?: string;
  sendAs?: string;
}

async function getOutlookBindingConfig(
  tenantId: string,
  agentId: string,
): Promise<OutlookBindingForAgent | undefined> {
  return getAgentConnectorBindingConfig<OutlookBindingForAgent & Record<string, unknown>>(
    tenantId,
    agentId,
    'microsoft_outlook_mail',
  );
}

// ──────────────────────────────────────────────────────────────────────
// GitHub PR event matcher — per-binding repo / branch / author / draft /
// action narrowing applied during dispatch to PR-review agents.
//
// Payload shape: matches the body PB's github-webhook-router.ts publishes
// (src/connectors/github-webhook-router.ts publishes the GitHub webhook
// body verbatim under payload.data). GitHub's native pull_request shape:
//   {
//     action: 'opened' | 'reopened' | 'ready_for_review' | 'synchronize' | 'closed' | …,
//     pull_request: {
//       number: 42,
//       user: { login: 'Alex Rivera' },
//       head: { ref: 'feature/foo', repo: { full_name: 'org/repo' } },
//       base: { ref: 'main', repo: { full_name: 'org/repo' } },
//       draft: false,
//     },
//     repository: { full_name: 'org/repo', name: 'repo', owner: { login: 'org' } },
//   }
//
// Binding filter shape (stored on the agent's `integrations[].config` for
// integration.type === 'github'):
//   - repos:           string[]   e.g. ['org/repo'] (case-sensitive full_name match)
//   - branches:        string[]   matches pull_request.base.ref
//   - authors:         string[]   matches pull_request.user.login
//   - skipDrafts:      boolean    default true; if pull_request.draft, skip
//   - allowedActions:  string[]   default ['opened', 'reopened', 'ready_for_review'];
//                                 explicit empty array = allow all actions
//
// Conservative: empty/missing filter = match everything (subject to the
// default skipDrafts + default allowedActions); presence-of-clause + no
// match = reject.
type GithubPullRequestEventPayload = {
  action?: string;
  pull_request?: {
    number?: number;
    user?: { login?: string };
    head?: { ref?: string; repo?: { full_name?: string } };
    base?: { ref?: string; repo?: { full_name?: string } };
    draft?: boolean;
    merged?: boolean;
  };
  repository?: { full_name?: string };
  [k: string]: unknown;
};

export interface GithubBindingFilter {
  repos?: string[];
  branches?: string[];
  authors?: string[];
  skipDrafts?: boolean;
  allowedActions?: string[];
}

const DEFAULT_GITHUB_ALLOWED_ACTIONS = ['opened', 'reopened', 'ready_for_review'];

export function githubEventMatches(
  filter: GithubBindingFilter | undefined,
  payload: GithubPullRequestEventPayload,
  opts?: { requireMerged?: boolean },
): boolean {
  const pr = payload.pull_request;
  if (!pr) return false;

  if (opts?.requireMerged) {
    // Merge-triggered agents (pr.merged topic, e.g. technical-writer): fire ONLY on a
    // true merge — action='closed' with pull_request.merged===true. A closed-but-unmerged
    // PR is not a merge. The default allowedActions below excludes 'closed', so a merge
    // agent needs this dedicated gate; the repo/branch/author narrowing below still applies.
    if (payload.action !== 'closed' || pr.merged !== true) return false;
  } else {
    // Draft veto. Default true — most PR-review agents don't want drafts.
    const skipDrafts = filter?.skipDrafts ?? true;
    if (skipDrafts && pr.draft === true) return false;

    // Action allowlist. Default to a conservative trio; explicit empty array
    // means "any action."
    const allowedActions = filter?.allowedActions ?? DEFAULT_GITHUB_ALLOWED_ACTIONS;
    if (allowedActions.length > 0) {
      if (!payload.action || !allowedActions.includes(payload.action)) {
        return false;
      }
    }
  }

  if (filter?.repos && filter.repos.length > 0) {
    const repoName = payload.repository?.full_name ?? pr.base?.repo?.full_name;
    if (!repoName || !filter.repos.includes(repoName)) return false;
  }

  if (filter?.branches && filter.branches.length > 0) {
    const baseRef = pr.base?.ref;
    if (!baseRef || !filter.branches.includes(baseRef)) return false;
  }

  if (filter?.authors && filter.authors.length > 0) {
    const author = pr.user?.login;
    if (!author || !filter.authors.includes(author)) return false;
  }

  return true;
}

interface GithubBindingForAgent {
  githubFilter?: GithubBindingFilter;
}

async function getGithubBindingConfig(
  tenantId: string,
  agentId: string,
): Promise<GithubBindingForAgent | undefined> {
  return getAgentConnectorBindingConfig<GithubBindingForAgent & Record<string, unknown>>(
    tenantId,
    agentId,
    'github',
  );
}

function makeKey(agentId: string, tenantId: string): string {
  return `${agentId}:${tenantId}`;
}

/**
 * Register an agent to be triggered by events matching the given topic.
 * Called when an event-driven agent is activated.
 *
 * Returns whether this call ADDED a registration the cache did not already
 * hold. Callers that reconcile need that distinction: re-asserting a
 * registration that was already correct is a no-op, while adding one the cache
 * was missing means this process had been deaf to the topic. Both used to log
 * the same line, so the second was invisible inside the first.
 */
export function registerEventAgent(agentId: string, tenantId: string, eventTopic: string): boolean {
  if (!eventAgentRegistry.has(eventTopic)) {
    eventAgentRegistry.set(eventTopic, new Set());
  }
  const agents = eventAgentRegistry.get(eventTopic)!;
  const key = makeKey(agentId, tenantId);
  const added = !agents.has(key);
  agents.add(key);

  if (added) {
    logger.info('Registered agent for event trigger', {
      agentId,
      tenantId,
      eventTopic,
      totalAgentsForTopic: agents.size,
    });
  }
  return added;
}

/**
 * Deregister an agent from event triggers.
 * Called when an event-driven agent is paused or archived.
 */
export function deregisterEventAgent(agentId: string, tenantId: string, eventTopic: string): void {
  const agents = eventAgentRegistry.get(eventTopic);
  if (agents) {
    agents.delete(makeKey(agentId, tenantId));
    if (agents.size === 0) {
      eventAgentRegistry.delete(eventTopic);
    }
  }

  logger.info('Deregistered agent from event trigger', {
    agentId,
    tenantId,
    eventTopic,
  });
}

/**
 * Map a connector event's source attribute to logical event topics.
 * This bridges the gap between connector sources (e.g., "google-mail")
 * and agent event topics (e.g., "email.received").
 */
function resolveEventTopics(source: string, entityType: string): string[] {
  const topics: string[] = [`${source}.${entityType}`]; // dynamic prefix always kept
  const aliases = routingMap.get(source.toLowerCase())?.get(entityType) ?? [];
  topics.push(...aliases);
  return topics;
}

/**
 * Attempt to claim an eventId for a tenant. Returns true if the event is new
 * (this call inserted it), false if already seen (duplicate).
 * Visible for testing.
 */
export async function markEventSeen(tenantId: string, eventId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO connector_event_seen (tenant_id, event_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [tenantId, eventId],
  );
  return result.rowCount === 1;
}

/**
 * Direct-call entry point for connector event dispatch — used by both the
 * Pub/Sub push handler (`handleConnectorEvent` below) and the control-
 * plane-events subscriber when a `connector.composio_trigger_fired` event
 * lands (commit pending — Composio webhooks deliver via PB → control-plane).
 *
 * Returns void; callers handle their own ack/nack semantics.
 */
/** How long a MISS may be trusted without re-reading the authority.
 *
 *  A topic nobody subscribes to is the ordinary case — most connector events
 *  are for entities no agent watches — so an unbounded refresh would issue a
 *  query per message, and the bound exists for that.
 *
 *  It is measured from the last successful LOAD, not from the last attempted
 *  refresh, and that distinction is the fix. The previous timer was stamped on
 *  the miss path, so it answered "how long since we last tried" — a question
 *  whose answer says nothing about whether the cache is stale. Two misses 31
 *  seconds apart both reloaded even when the cache was fresh; a burst of misses
 *  right after a lifecycle change all declined to reload precisely when it was
 *  not.
 *
 *  Five seconds rather than thirty because the cost of being wrong is
 *  asymmetric: the ceiling here is one query every five seconds per process
 *  against a single-tenant Postgres, and the thing it buys is not dropping a
 *  real event that a person is waiting on. */
const REGISTRY_NEGATIVE_TRUST_MS = 5_000;
let lastRegistryLoadAt = 0;
function registryMissIsTrustworthy(): boolean {
  return Date.now() - lastRegistryLoadAt < REGISTRY_NEGATIVE_TRUST_MS;
}

export async function dispatchConnectorEventDirect(args: {
  source: string;
  entityType: string;
  tenantId: string;
  eventId?: string;
  /** Mirror of the Pub/Sub payload shape: { eventId, payload: { source, data } }
   *  — kept opaque here so the per-binding filters (gmailQuery,
   *  outlookFilter) can keep reading `data.payload.data` unchanged. */
  data: { payload?: { source?: string; data?: unknown } };
}): Promise<void> {
  const { source, entityType, tenantId, eventId, data } = args;

  if (eventId && !(await markEventSeen(tenantId, eventId))) {
    logger.info('Connector event already seen, skipping', { tenantId, eventId, source, entityType });
    recordTriggerSkip('connector_event', 'duplicate_event');
    return;
  }

  // Resolve which event topics this connector event maps to
  const matchingTopics = resolveEventTopics(source, entityType);

  // Find all registered agents that match any of these topics. Carry the topic the
  // agent registered under (matchedTopic) so action-specific filtering (e.g. pr.merged
  // → only real merges) can key off the agent's declared intent.
  const matchAgainstRegistry = (): Array<EventAgentEntry & { matchedTopic: string }> => {
    const found: Array<EventAgentEntry & { matchedTopic: string }> = [];
    for (const topic of matchingTopics) {
      const agents = eventAgentRegistry.get(topic);
      if (agents) {
        for (const key of agents) {
          const entry = parseKey(key);
          // Tenant isolation: only trigger agents belonging to the same tenant
          if (entry.tenantId === tenantId) {
            found.push({ ...entry, matchedTopic: topic });
          }
        }
      }
    }
    return found;
  };

  let matchedAgents = matchAgainstRegistry();

  // A miss is a CACHE miss, not proof that no agent wants this event.
  //
  // `eventAgentRegistry` is filled once, by `loadEventAgentsFromDB()` at
  // subscriber startup, and mutated in-process by activate()/pause(). But this
  // runtime is deployed as several Cloud Run services from one image, and the
  // event subscriber lives in agent-service while a lifecycle change can be
  // handled in coordinator-service. That change updates the registry in the
  // process that served it and in no other, so an agent resumed anywhere else
  // stays invisible here until agent-service happens to restart.
  //
  // So a paused agent can be resumed, its Composio trigger fire, the event
  // travel the whole path in under a second — webhook → control-plane-events →
  // coordinator → connector-events → this function — and be dropped with
  // `no_registered_agents`, logged as "that's normal". The mail sits unanswered
  // while every hop reports success.
  //
  // So on a miss the registry is reloaded from the database once and the match
  // retried. The DB is the source of truth; the map is an optimisation. The
  // reload is rate-limited because a topic with genuinely no subscriber is the
  // common case (every connector event for an entity nobody watches lands
  // here) and must not become a query per message.
  // The map is a CACHE; the database is the authority.
  //
  // A miss is only as trustworthy as the cache is fresh, so the reload is
  // bounded by the age of the last successful LOAD (see
  // REGISTRY_NEGATIVE_TRUST_MS) rather than by how recently a refresh was
  // attempted.
  //
  // An empty-for-this-tenant registry always reloads regardless of that bound.
  // That is the state a redistill leaves behind — registerEventAgent mutates an
  // in-process map and the lifecycle change is often served by
  // coordinator-service while this subscriber lives in agent-service — and
  // rate-limiting it means the authority is never consulted while a configured
  // agent stays invisible: a hole that lasts until a reconciler next
  // re-registers the agent.
  //
  // Note that this condition alone was NOT enough, which is why the trust
  // bound above is short. A redistill that RETARGETS an agent leaves its old
  // topic registered, so the tenant still looks registered and only the
  // freshness bound saves the event. The reload itself now converges (it
  // replaces rather than merges), so the stale topic actually disappears.
  const tenantHasNoRegistrations = ![...eventAgentRegistry.values()]
    .some((keys) => [...keys].some((k) => parseKey(k).tenantId === tenantId));
  if (matchedAgents.length === 0 && (tenantHasNoRegistrations || !registryMissIsTrustworthy())) {
    try {
      await loadEventAgentsFromDB();
      matchedAgents = matchAgainstRegistry();
      if (matchedAgents.length > 0) {
        logger.info('Event-agent registry was stale; refreshed from DB and matched', {
          source, entityType, tenantId, matchingTopics, agentCount: matchedAgents.length,
        });
      }
    } catch (err) {
      // A refresh failure must not swallow the event differently from any other
      // miss — fall through to the skip below, which is what would have
      // happened anyway.
      logger.warn('Event-agent registry refresh failed', { err: (err as Error).message });
    }
  }

  if (matchedAgents.length === 0) {
    // Genuinely nobody is watching this topic, confirmed against the DB rather
    // than against a snapshot taken at boot.
    //
    // LOGGED, not only counted. A topic nobody subscribes to is the ordinary
    // case, so this used to be a bare metric — and that made the ONE case that
    // matters indistinguishable from it: an agent that IS configured for this
    // topic and was invisible at this instant.
    //
    // That happens for a known reason. `registerEventAgent` mutates an
    // in-process map, and a lifecycle change can be served by coordinator-
    // service while this subscriber lives in agent-service, so a redistill
    // re-registers in the wrong process and the DB reload above finds the agent
    // mid-update rather than ACTIVE. The agent then stays deaf until a
    // reconciler re-registers it, and an event that lands in that window is
    // dropped with no trace beyond a counter.
    //
    // The design note records agents "going quiet after a redistill" as looking
    // identical to a broken trigger. This is the line that tells them apart.
    logger.info('Connector event matched no registered agent', {
      source,
      entityType,
      tenantId,
      matchingTopics,
      registryTopics: eventAgentRegistry.size,
      hint: 'if an agent IS configured for one of these topics, its in-process '
        + 'registration is stale — see the reconciler and agent-lifecycle registerEventAgent',
    });
    recordTriggerSkip('connector_event', 'no_registered_agents');
    return;
  }

  logger.info('Routing connector event to agents', {
    source,
    entityType,
    tenantId,
    matchingTopics,
    agentCount: matchedAgents.length,
  });

  // Invoke each matched agent (with lifecycle re-check)
  const invocations = matchedAgents.map(async ({ agentId, matchedTopic }) => {
      try {
        // Re-check lifecycle before LLM execution. The in-memory registry
        // is populated at startup from ACTIVE agents, but an agent may have
        // been paused since then. Without this check, events would route to
        // paused agents and call executeTask() → LLM inference.
        const pool = getPool();
        const lcCheck = await pool.query(
          `SELECT lifecycle FROM agents WHERE id = $1 LIMIT 1`,
          [agentId]
        );
        if (lcCheck.rows[0]?.lifecycle !== 'ACTIVE') {
          logger.info('Event-triggered agent skipped: not ACTIVE', {
            agentId,
            tenantId,
            lifecycle: lcCheck.rows[0]?.lifecycle ?? 'not_found',
            source,
          });
          recordTriggerSkip('connector_event', 'agent_not_active');
          return;
        }

        // Per-binding Gmail filter: when the agent has a google_mail binding
        // with a gmailQuery, only invoke if the event matches. Polling cursor
        // stays per-connector; filtering is purely a routing-time predicate.
        if (source === 'google_mail') {
          const eventMessage = (data.payload?.data ?? {}) as {
            labelIds?: string[];
            headers?: { To?: string; From?: string };
          };
          // Drop events for the agent's own drafts. When an outbound tool is
          // substituted under `communication: 'draft'` (send_email →
          // create_draft), the resulting Gmail draft lands back on the same
          // thread and Composio's GMAIL_NEW_GMAIL_MESSAGE trigger fires for
          // it. Without this filter the agent re-processes the thread,
          // produces another draft, which re-triggers, ad infinitum.
          // Same hazard applies to
          // any composio_managed mail connector under draft mode — Outlook
          // gets the symmetric filter below.
          if (Array.isArray(eventMessage.labelIds) && eventMessage.labelIds.includes('DRAFT')) {
            logger.info('Event-triggered agent skipped: gmail event is a self-originated DRAFT', {
              agentId,
              tenantId,
              source,
            });
            recordTriggerSkip('connector_event', 'gmail_self_draft');
            return;
          }
          const gmailBinding = await getAgentConnectorBinding<GmailBindingForAgent & Record<string, unknown>>(
            tenantId, agentId, 'google_mail',
          );
          const binding = gmailBinding?.config;
          if (binding?.gmailQuery) {
            const connectorId = gmailBinding?.connectorId;
            const verdict = connectorId
              ? await gmailQueryMatchesViaGmail({
                  tenantId, agentId, connectorId,
                  query: binding.gmailQuery,
                  message: eventMessage,
                })
              : { matched: true, decided: false, reason: 'no_connector_binding_id' };

            if (!verdict.decided) {
              // Loud, and it proceeds. A binding whose predicate could not be
              // evaluated is a fault to fix, not a reason to drop a customer
              // email — and the previous behaviour of silently skipping is
              // exactly how a broken query went unnoticed.
              logger.error('gmailQuery could not be evaluated by Gmail — processing the event anyway', {
                agentId, tenantId, source,
                gmailQuery: binding.gmailQuery,
                reason: verdict.reason,
              });
              // Deliberately NOT recordTriggerSkip: the event was not skipped.
              // Filing a non-skip under the skip metric would make the one
              // number that answers "how much mail are we dropping" untrue.
            } else if (!verdict.matched) {
              logger.info('Event-triggered agent skipped: gmailQuery did not match', {
                agentId,
                tenantId,
                source,
                gmailQuery: binding.gmailQuery,
                // What Gmail was asked and what came back. Without these the
                // log states a conclusion and no evidence, and a check that
                // answered "no" to every message for a whole day was
                // indistinguishable from one working correctly.
                reason: verdict.reason,
                matchedCount: verdict.observed,
              });
              recordTriggerSkip('connector_event', 'gmail_query_no_match');
              return;
            }
          }
        }

        // Per-binding Outlook filter: same pattern as Gmail above, predicate
        // is the OData $filter subset supported by outlookEventMatches().
        if (source === 'microsoft_outlook_mail') {
          const eventMessage = (data.payload?.data ?? {}) as OutlookEventMessage & {
            isDraft?: unknown;
            is_draft?: unknown;
            parentFolderId?: unknown;
          };
          // Drop the agent's own draft, mirroring the Gmail filter above.
          // Composio's Outlook trigger reports `isDraft: true` on
          // draft-state messages (and snake_case `is_draft` for parity with
          // other vendor payloads we've seen). Either way, skip.
          if (eventMessage.isDraft === true || eventMessage.is_draft === true) {
            logger.info('Event-triggered agent skipped: outlook event is a self-originated draft', {
              agentId,
              tenantId,
              source,
            });
            recordTriggerSkip('connector_event', 'outlook_self_draft');
            return;
          }
          const binding = await getOutlookBindingConfig(tenantId, agentId);
          if (binding?.outlookFilter) {
            if (!outlookEventMatches(binding.outlookFilter, eventMessage)) {
              logger.info('Event-triggered agent skipped: outlookFilter did not match', {
                agentId,
                tenantId,
                source,
                outlookFilter: binding.outlookFilter,
              });
              recordTriggerSkip('connector_event', 'outlook_filter_no_match');
              return;
            }
          }
        }

        // Per-binding GitHub PR filter: repo / branch / author / draft /
        // action narrowing for PR-review agents.
        // The dispatch envelope here is the connector-events-${env} message
        // body that github-webhook-router.ts publishes; payload.data holds
        // the GitHub webhook's native pull_request body (action,
        // pull_request, repository) — see githubEventMatches doc-comment.
        // githubEventMatches is called unconditionally because its defaults
        // (skipDrafts=true + allowedActions=['opened','reopened','ready_for_review'])
        // should apply even with no per-agent filter configured.
        if (source === 'github') {
          const payload = (data.payload?.data ?? {}) as GithubPullRequestEventPayload;
          if (payload.pull_request) {
            // PR events. A pr.merged-topic agent (e.g. technical-writer) fires only on a
            // true merge; all other pr.* topics keep the open-PR-review default
            // (draft veto + allowedActions). The per-binding githubFilter (repos/branches/
            // authors) still narrows both.
            const requireMerged = matchedTopic === 'pr.merged';
            const binding = await getGithubBindingConfig(tenantId, agentId);
            if (!githubEventMatches(binding?.githubFilter, payload, { requireMerged })) {
              logger.info('Event-triggered agent skipped: githubFilter did not match', {
                agentId,
                tenantId,
                source,
                matchedTopic,
                requireMerged,
                hadFilter: Boolean(binding?.githubFilter),
                action: payload.action,
                merged: payload.pull_request?.merged,
                repo: payload.repository?.full_name,
                draft: payload.pull_request?.draft,
              });
              recordTriggerSkip('connector_event', 'github_filter_no_match');
              return;
            }
          } else if (entityType === 'Issue') {
            // Issue events → code-writing agents (github.Issue topic). githubEventMatches
            // is PR-only and would drop every issue; route them instead, filtered to the
            // "new work" actions so an edited/closed/labeled issue does not re-fire the
            // agent. Gated on entityType so IssueComment/other github entities (which also
            // carry an `issue` field) are NOT caught by this action allowlist. Additive:
            // PR-review agents on pr.* topics are unaffected.
            const ACTIONABLE_ISSUE_ACTIONS = ['opened', 'reopened', 'assigned'];
            if (payload.action && !ACTIONABLE_ISSUE_ACTIONS.includes(payload.action)) {
              logger.info('Event-triggered agent skipped: github issue action not actionable', {
                agentId,
                tenantId,
                source,
                action: payload.action,
              });
              recordTriggerSkip('connector_event', 'github_issue_action_not_actionable');
              return;
            }
          }
        }

        const thread = await getInvocationsService().createThread({
          tenantId,
          agentId,
          initiatedByType: 'scheduler',
          title: `Event trigger: ${source}.${entityType} - ${new Date().toISOString()}`,
        });

        // workflows.id and workflow_tasks.id are PostgreSQL UUID columns —
        // the escalation-helper INSERTs against both when the agent escalates,
        // and postgres rejects any value that doesn't parse as a UUID with
        // `invalid input syntax for type uuid`. The prior `event-wf-${uuid}`
        // prefix was useful for log skim but it broke every event-triggered
        // escalation path: the helper INSERT failed, the invocation died with
        // outcome=error, and Composio's poll cadence re-fired the same event
        // 10 min later into a still-locked agent. Use pure UUIDs; if log-side
        // origin tagging is needed later, add it as a `source` column or a
        // structured log field, not as a string-mangled primary key.
        const workflowId = uuidv4();
        const taskId = uuidv4();

        const triggerKey = eventId ? `evt:${eventId}:${agentId}` : `evt:${source}:${entityType}:${workflowId}:${agentId}`;
        const result = await getAgentExecutionService().executeTask({
          tenantId,
          agentId,
          workflowId,
          taskId,
          objective: `Process incoming ${source} event: ${JSON.stringify(data.payload?.data || {}).slice(0, 500)}`,
          threadId: thread.id,
          triggeredBy: 'event',
          // The structured trigger, which this path did not set.
          //
          // `source` was already here in inputData, as prose for the model. It
          // was never stamped on the run itself, and two things depended on
          // that: trustLevelFor(undefined) is 'trusted', so external-authored
          // content (a GitHub pull-request title is written by whoever opened
          // it) arrived trusted here while the SAME event through the
          // reactive-subscription path arrived untrusted_inbound; and a
          // workflow step that names an operation instead of a host had no host
          // to resolve against, so it refused.
          //
          // One event, two dispatchers, two different answers. Built through the
          // shared helper now, so the shape cannot drift apart again.
          trigger: connectorEventTrigger(source, entityType),
          inputData: {
            eventSource: source,
            eventEntityType: entityType,
            // The normalized entity this run was woken by, and the only part of
            // a connector payload a workflow may address by name. Without it
            // `{{input.<field>}}` had nothing correct to resolve against: the
            // raw payload sits a level down under `eventData` AND spells the
            // same field two ways depending on delivery path. See
            // event-input-envelope.ts.
            message: buildEventMessageEnvelope(source, data.payload?.data as Record<string, unknown> | undefined),
            // Unchanged, and deliberately kept: every existing reader of the raw
            // payload keeps working, and a field the envelope does not carry is
            // still reachable.
            eventData: data.payload?.data,
          },
          triggerKey,
          onConflict: 'defer',
        });

        if (!result.deferred) {
          await getInvocationsService().updateThreadStatus(
            thread.id,
            tenantId,
            THREAD_STATUS_BY_TERMINAL[resolveTerminalState(result, false)]
          );
        }

        logger.info(result.deferred ? 'Event-triggered agent execution deferred' : 'Event-triggered agent execution completed', {
          agentId,
          tenantId,
          threadId: thread.id,
          source,
          success: result.success,
          deferred: result.deferred === true,
        });
      } catch (error) {
        logger.error('Event-triggered agent execution failed', {
          agentId,
          tenantId,
          source,
          error: (error as Error).message,
        });
      }
    });

    await Promise.allSettled(invocations);
}

/**
 * Pub/Sub push wrapper. Parses the Message envelope and delegates to
 * dispatchConnectorEventDirect. Owns the ack/nack lifecycle so the
 * subscription doesn't redeliver on processing failure beyond what
 * dispatchConnectorEventDirect tolerates internally.
 */
async function handleConnectorEvent(message: Message): Promise<void> {
  try {
    const data = JSON.parse(message.data.toString());
    const source = message.attributes?.source || data.payload?.source || 'unknown';
    const entityType = message.attributes?.entityType || data.entityType || 'record';
    const tenantId = message.attributes?.tenantId || data.tenantId;

    if (!tenantId) {
      logger.warn('Connector event missing tenantId, skipping', { source, entityType });
      message.ack();
      return;
    }

    await dispatchConnectorEventDirect({
      source,
      entityType,
      tenantId,
      eventId: data.eventId,
      data,
    });
    message.ack();
  } catch (error) {
    logger.error('Failed to process connector event', {
      error: (error as Error).message,
    });
    message.nack();
  }
}

async function loadEventTopicsFromCatalog(): Promise<void> {
  const baseUrl = (process.env.CONNECTOR_SERVICE_URL ?? '').replace(/\/$/, '');
  const token = getManagedSecret('CONNECTOR_SERVICE_TOKEN');
  const res = await fetch(`${baseUrl}/api/connectors/catalog/`, {
    headers: {
      ...(token ? { 'X-Service-Auth': token } : {}),
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`);
  const catalog = await res.json() as ConnectorCatalogResponse;

  const newMap = new Map<string, Map<string, string[]>>();
  const dispatch: Record<string, ComposioTriggerDispatch> = {};
  for (const def of catalog.connectors) {
    if (!def.polling) continue;
    const entityMap = new Map<string, string[]>();
    for (const p of def.polling) {
      entityMap.set(p.entityType, p.eventTopics);
      // Single-source trigger dispatch: a polling entry's eventTrigger maps its
      // Composio slug → (source, entityType) for handleComposioTriggerFired.
      if (p.eventTrigger) dispatch[p.eventTrigger.slug] = { source: def.type, entityType: p.entityType };
    }
    newMap.set(def.type, entityMap);
  }
  routingMap = newMap;
  setCatalogTriggerDispatch(dispatch);
  logger.info(
    { connectorCount: routingMap.size, triggerDispatch: Object.keys(dispatch).length },
    'event routing map + trigger dispatch loaded',
  );
}

/**
 * Load all active event-triggered agents from the database into the registry.
 *
 * REPLACES the registry rather than merging into it, and that is the whole
 * point. This used to call `registerEventAgent` in a loop, which only ever
 * ADDS — so a reload could add a registration the cache was missing but could
 * never drop one the database no longer backs. The map was not a cache of the
 * database; it was an accumulator of everything that had ever been true.
 *
 * Two consequences, both silent:
 *
 *  - A redistill that RETARGETS an agent (topic X -> topic Y) left X
 *    registered. The tenant therefore looked registered, so the miss path's
 *    "this tenant has nothing" reload never fired, and events for Y were
 *    dropped for as long as the rate limiter held.
 *  - A paused or archived agent stayed registered until the pod restarted, so
 *    it could still be woken by an event it no longer subscribed to. That is
 *    worse than deafness: deafness loses work, a spurious wake invents it.
 *
 * Rebuilding from the query result makes "the database is the authority"
 * literally true — a registration survives a reload only if a row still backs
 * it. The swap is done in place under a single synchronous block so a
 * concurrent match never observes a half-built registry.
 */
export async function loadEventAgentsFromDB(): Promise<void> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, tenant_id, trigger_config
     FROM agents
     WHERE lifecycle = 'ACTIVE'
       AND trigger_config IS NOT NULL
       AND trigger_config->>'type' = 'event'`
  );

  const fresh = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const triggerConfig = typeof row.trigger_config === 'string'
      ? JSON.parse(row.trigger_config)
      : row.trigger_config;
    const eventTopic = triggerConfig.eventTopic || triggerConfig.event_topic;
    if (!eventTopic) continue;
    if (!fresh.has(eventTopic)) fresh.set(eventTopic, new Set());
    fresh.get(eventTopic)!.add(makeKey(row.id, row.tenant_id));
  }

  // Diff before the swap, so a registration the database no longer backs is
  // reported rather than just disappearing. A drop here is the trace of a
  // lifecycle change that this process never saw.
  const dropped: string[] = [];
  for (const [topic, keys] of eventAgentRegistry) {
    for (const key of keys) {
      if (!fresh.get(topic)?.has(key)) dropped.push(`${topic}:${key}`);
    }
  }

  eventAgentRegistry.clear();
  for (const [topic, keys] of fresh) eventAgentRegistry.set(topic, keys);
  lastRegistryLoadAt = Date.now();

  if (dropped.length > 0) {
    logger.info('Event-agent registry reload dropped registrations the DB no longer backs', {
      droppedCount: dropped.length,
      dropped: dropped.slice(0, 20),
    });
  }
  logger.info('Loaded event-triggered agents from DB', {
    agentCount: result.rows.length,
    topicCount: eventAgentRegistry.size,
  });
}

/**
 * Start the connector events subscriber.
 * Listens to connector-events-{env} and routes to registered agents.
 */
export async function startEventTriggerSubscriber(): Promise<void> {
  const subscriptionName = `connector-events-agent-trigger-${environment}-sub`;

  connectorEventsSubscription = pubsub.subscription(subscriptionName);

  // Check if subscription exists, create if not
  const [exists] = await connectorEventsSubscription.exists();
  if (!exists) {
    const topicName = `connector-events-${environment}`;
    const topic = pubsub.topic(topicName);
    const [topicExists] = await topic.exists();
    if (!topicExists) {
      await topic.create();
      logger.info('Created connector-events topic', { topicName });
    }
    [connectorEventsSubscription] = await topic.createSubscription(subscriptionName, {
      ackDeadlineSeconds: 60,
      expirationPolicy: { ttl: null }, // Never expire
    });
    logger.info('Created connector-events subscription', { subscriptionName });
  }

  connectorEventsSubscription.on('message', handleConnectorEvent);
  connectorEventsSubscription.on('error', (error) => {
    logger.error('Connector events subscription error', { error: error.message });
  });

  await loadEventTopicsFromCatalog(); // required — throws if connector-service unavailable
  // Load existing event agents from DB
  await loadEventAgentsFromDB();

  logger.info('Event trigger subscriber started', {
    subscription: subscriptionName,
    registeredTopics: Array.from(eventAgentRegistry.keys()),
  });
}

/**
 * Stop the connector events subscriber.
 */
export async function stopEventTriggerSubscriber(): Promise<void> {
  if (connectorEventsSubscription) {
    connectorEventsSubscription.removeAllListeners();
    await connectorEventsSubscription.close();
    connectorEventsSubscription = null;
  }
  eventAgentRegistry.clear();
  logger.info('Event trigger subscriber stopped');
}
