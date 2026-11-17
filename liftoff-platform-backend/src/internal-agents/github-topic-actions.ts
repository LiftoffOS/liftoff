// A declared topic and the filter that lets it arrive are one fact.
//
// The distiller writes `eventTopic: pr.updated`. The tenant runtime separately
// decides which GitHub webhook actions reach an agent, defaulting to
// `['opened','reopened','ready_for_review']` when the binding names none. Those
// are two places answering one question, free to disagree, and the disagreement
// is invisible: the topic is declared, the event is delivered, the runtime drops
// it, and nothing anywhere reports a drop that was configured.
//
// Same shape as `deliversEvents` vs `listImplemented`. Fixing one action leaves
// the mechanism intact for the next topic, so the filter is DERIVED here from
// the topics the distiller already declares, and the analyzer refuses any config
// where the two disagree.
//
// This map is the single source. `event-trigger.ts`'s default stays where it is
// and is not touched: it is the right answer for an agent that declared no
// intent, and changing it would re-review on every push for every GitHub agent
// in the estate. Per-agent intent wins; the default catches the rest.

/**
 * GitHub webhook actions that make each PR topic arrive.
 *
 * `pr.merged` is the odd one: GitHub has no `merged` action, it sends `closed`
 * with `pull_request.merged === true`. So the topic needs `closed` in the
 * allow-list AND the runtime's `requireMerged` gate, which fires on the matched
 * topic rather than on the filter. Both halves are required — `closed` alone
 * would also admit a closed-unmerged PR.
 */
export const GITHUB_TOPIC_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  'pr.opened': ['opened'],
  'pr.updated': ['synchronize'],
  'pr.ready_for_review': ['ready_for_review'],
  'pr.reopened': ['reopened'],
  'pr.merged': ['closed'],
  // A push to a branch, which for a PR-shaped subscription is the same webhook
  // action as pr.updated.
  'code.pushed': ['synchronize'],
};

/**
 * The floor a derived filter may never fall below.
 *
 * MIRRORS `DEFAULT_GITHUB_ALLOWED_ACTIONS` in the tenant runtime's
 * `src/scheduling/event-trigger.ts`. If that default changes, change this with
 * it — the value is asserted in this module's tests so the pair is at least
 * visible from one side.
 *
 * A derived filter REPLACES that default, so deriving strictly from the
 * declared topics makes a config narrower than the behaviour it displaced
 * whenever the declaration is thinner than the responsibilities. A GitHub-bound
 * event agent commonly names reopen and push handling in its responsibilities
 * while declaring `pr.opened` alone, so a strict derivation would quietly stop
 * it from reviewing a reopened or ready-for-review pull request.
 *
 * So the derivation UNIONS with this floor: it can only ever widen. An
 * explicitly authored `allowedActions` is still honoured verbatim — that path
 * never reaches here — which keeps deliberate narrowing possible while
 * accidental narrowing is not.
 *
 * A merge-only agent inherits the floor and is unaffected by it: the runtime
 * takes its `requireMerged` branch on a `pr.merged` match and never consults
 * `allowedActions`.
 */
export const RUNTIME_DEFAULT_ALLOWED_ACTIONS: readonly string[] = [
  'opened', 'reopened', 'ready_for_review',
];

/**
 * The pull-request REVIEW lifecycle: one concern, four webhook actions.
 *
 * Declaring any of these topics admits all of them, and the reason is not
 * convenience. A review agent that fires on `opened` and not on `synchronize`
 * produces a review that goes stale the moment the author pushes a response to
 * it — the work is the same work, and the pull request is the same pull
 * request, at a new revision.
 *
 * GitHub-bound event agents typically name push/update handling in their
 * responsibilities and declare `pr.opened` alone: the declaration is
 * impoverished relative to the role.
 *
 * THIS IS A WIDENING, AND IT IS NOT THE HONEST FIX. The honest fix is for the
 * distiller to declare every lifecycle topic the responsibilities name, so the
 * config says what the agent does. That is a prompt change, it invalidates the
 * distill cache for every agent, and it routes the extra topics through
 * `reactiveSubscriptions`, whose connectorRef validation demonstrably fails for
 * these bindings and falls back to companion crons — which would reintroduce
 * the polling this whole change removed. It belongs behind redistill-canary.
 *
 * Safe to do first because delivery never depended on the declaration.
 * `resolveEventTopics` resolves entity-level, so a synchronize event already
 * matches an agent registered on `pr.opened` — verified live, dev 23:50:20:
 * `Routing connector event to agents agentCount=1` with `action=synchronize`,
 * dropped afterwards by `allowedActions` alone. Only this list gated it.
 *
 * `pr.merged` is deliberately NOT in here. Post-merge work is a different
 * concern from reviewing, and a merge-triggered agent has no business firing on
 * a push.
 */
const REVIEW_LIFECYCLE_TOPICS: ReadonlySet<string> = new Set([
  'pr.opened', 'pr.updated', 'pr.ready_for_review', 'pr.reopened', 'code.pushed',
]);

const REVIEW_LIFECYCLE_ACTIONS: readonly string[] = [
  'opened', 'reopened', 'ready_for_review', 'synchronize',
];

/**
 * The actions a set of declared topics needs in order to arrive.
 *
 * Returns undefined when no declared topic is a GitHub PR topic — an agent
 * triggered on `issue.created` or on nothing at all must not have a
 * pull-request filter invented for it. Undefined means "say nothing", which
 * leaves the runtime default in charge; an empty array would mean "allow every
 * action" and is a different, much wider statement.
 */
export function deriveGithubAllowedActions(topics: Iterable<string>): string[] | undefined {
  const actions = new Set<string>();
  let sawKnownTopic = false;

  for (const raw of topics) {
    const topic = (raw ?? '').trim();
    const mapped = GITHUB_TOPIC_ACTIONS[topic];
    if (!mapped) continue;
    sawKnownTopic = true;
    for (const a of mapped) actions.add(a);
    // One concern, four actions — see REVIEW_LIFECYCLE_TOPICS.
    if (REVIEW_LIFECYCLE_TOPICS.has(topic)) {
      for (const a of REVIEW_LIFECYCLE_ACTIONS) actions.add(a);
    }
  }

  if (!sawKnownTopic) return undefined;
  // Never narrower than the default this displaces. See
  // RUNTIME_DEFAULT_ALLOWED_ACTIONS — a derivation that can only widen fails
  // toward the previous behaviour rather than away from it.
  for (const a of RUNTIME_DEFAULT_ALLOWED_ACTIONS) actions.add(a);
  // Sorted so the value is stable across runs: this lands in a stored config
  // and an unstable order would show up as a spurious diff on every redistill.
  return [...actions].sort();
}

/**
 * Topics a filter would silently drop.
 *
 * The question the analyzer asks: this config declares these topics, and this
 * `allowedActions` is what the runtime will apply — which of the declared
 * topics can never arrive?
 *
 * A topic outside `GITHUB_TOPIC_ACTIONS` is ignored rather than reported. Only
 * GitHub PR topics are governed by `allowedActions`, and reporting an
 * `issue.created` here would be a false alarm about a filter that does not
 * apply to it.
 */
export function githubTopicsDroppedByFilter(
  topics: Iterable<string>,
  allowedActions: readonly string[] | undefined,
): string[] {
  // No filter means the runtime default applies. That default is not a
  // disagreement to report here — it is the state this whole derivation exists
  // to replace, and the analyzer reports it through the missing-filter rule
  // rather than by pretending a filter exists.
  if (!allowedActions) return [];
  // An explicit empty array means "any action", which drops nothing.
  if (allowedActions.length === 0) return [];

  const allowed = new Set(allowedActions);
  const dropped: string[] = [];
  for (const raw of topics) {
    const topic = (raw ?? '').trim();
    const needed = GITHUB_TOPIC_ACTIONS[topic];
    if (!needed) continue;
    if (!needed.some((a) => allowed.has(a))) dropped.push(topic);
  }
  return [...new Set(dropped)].sort();
}

interface TriggerConfigShape {
  eventTopic?: unknown;
  eventTopics?: unknown;
  reactiveSubscriptions?: unknown;
  companionCrons?: unknown;
}

/**
 * Every topic a trigger config declares, from wherever it declares them.
 *
 * Read from more than `eventTopic` on purpose: an agent routinely names one
 * primary topic and carries the rest on reactive subscriptions, and a filter
 * derived from the primary alone would drop exactly the cases the subscriptions
 * exist to catch.
 */
export function collectDeclaredTopics(triggerConfig: unknown): string[] {
  const tc = (triggerConfig ?? {}) as TriggerConfigShape;
  const out = new Set<string>();

  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) out.add(v.trim());
  };

  add(tc.eventTopic);
  // `eventTopics` is the declaration proper: the full set the agent handles,
  // carrying no subscription and no schedule with it. Deliberately NOT routed
  // through reactiveSubscriptions, whose connectorRef validation fails for
  // these bindings and falls back to companion crons — which is how declaring
  // more topics would have reinstated the polling this work removed.
  if (Array.isArray(tc.eventTopics)) for (const t of tc.eventTopics) add(t);

  const fromEntry = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as { eventTopic?: unknown; topic?: unknown; topics?: unknown };
    add(e.eventTopic);
    add(e.topic);
    if (Array.isArray(e.topics)) for (const t of e.topics) add(t);
  };

  if (Array.isArray(tc.reactiveSubscriptions)) tc.reactiveSubscriptions.forEach(fromEntry);
  if (Array.isArray(tc.companionCrons)) tc.companionCrons.forEach(fromEntry);

  return [...out];
}

export interface GithubFilterDerivation {
  /** Integration ids the filter was written onto. Empty when nothing applied. */
  appliedTo: string[];
  /** The derived action list, for logging. */
  allowedActions?: string[];
}

/**
 * Write the derived `githubFilter.allowedActions` onto each bound GitHub
 * integration's config.
 *
 * Runs after normalization and before the validators, so the analyzer checks
 * the artifact that will actually be stored rather than the model's draft.
 *
 * IDEMPOTENT, AND DELIBERATELY OVERWRITES. `githubFilter` is not in the
 * produce_agent tool schema, so the model cannot author one here: any
 * `allowedActions` already on a distill result is a value THIS function derived
 * earlier, most likely on the day a cached result was written. Skipping it
 * would freeze that day's mapping into every cached distillation, so a later
 * correction — the floor rule, a new topic — would ship green and reach no
 * agent whose inputs had not changed.
 *
 * An operator's own narrowing lives on the BINDING, not here, and a filter that
 * disagrees with the declared topics is reported by
 * `findTopicsTheFilterWouldDrop` rather than silently corrected.
 *
 * Other `githubFilter` keys (repos, branches, authors, skipDrafts) are
 * preserved — only the derived field is replaced.
 */
export function applyDerivedGithubFilter(
  toolInput: Record<string, unknown>,
  githubIntegrationIds: readonly string[],
): GithubFilterDerivation {
  if (githubIntegrationIds.length === 0) return { appliedTo: [] };

  const actions = deriveGithubAllowedActions(collectDeclaredTopics(toolInput.triggerConfig));
  if (!actions) return { appliedTo: [] };

  const configs = (toolInput.integrationConfigs && typeof toolInput.integrationConfigs === 'object'
    && !Array.isArray(toolInput.integrationConfigs))
    ? toolInput.integrationConfigs as Record<string, Record<string, unknown>>
    : {};

  const appliedTo: string[] = [];
  for (const id of githubIntegrationIds) {
    const existing = (configs[id] && typeof configs[id] === 'object') ? configs[id] : {};
    const filter = (existing.githubFilter && typeof existing.githubFilter === 'object')
      ? existing.githubFilter as Record<string, unknown>
      : {};
    // Unchanged is not applied, so a cache hit that needs no correction does not
    // report one — the operator's dry-run diff should only show real movement.
    if (JSON.stringify(filter.allowedActions) === JSON.stringify(actions)) continue;
    configs[id] = { ...existing, githubFilter: { ...filter, allowedActions: actions } };
    appliedTo.push(id);
  }

  if (appliedTo.length > 0) toolInput.integrationConfigs = configs;
  return { appliedTo, allowedActions: actions };
}
