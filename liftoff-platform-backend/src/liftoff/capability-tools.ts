// Capability discovery and execution, as Liftoff assistant tools.
//
// Two tools, one discipline: capability_search ranks the best building blocks
// from the platform's own curated surface (never a live marketplace — every
// candidate is a named tool with its own classification row), and
// run_capability executes exactly one of them through the single guarded
// dispatch path in capability-discovery/vendor-execution.
//
// CAPABILITY-FIRST, NOT VENDOR-FIRST. The model never sees which vendor backs a
// capability: search returns an opaque `capabilityId` (never a connector type
// or vendor name), and run_capability takes that id. A vendor name on the model
// boundary can be spoken into the chat, and the Chief AI Officer absorbs that
// transcript when it builds an agent — so the vendor identity is stripped here
// and resolved only inside the executor. The resolver there also runs on the
// tenant's OWN credential when they connected the vendor, else the platform
// key; billing is the correct Operating Units either way.
//
// CONTINUATION IS DIRECTED, NOT BLIND. A capability that produced nothing —
// a failure, or a run that answered with an empty envelope — is followed by
// the next candidate for the same need, but only in one of two safe ways:
// automatically, when the model's arguments validate unchanged against that
// candidate's COMPLETE input schema and it is affirmatively a read; or as a
// HANDOFF, where the model is handed a fresh handle for it and the arguments
// it takes. A different function run with the wrong argument names answers a
// different question with a result that looks like one; that is the chain
// this replaces. One attempted endpoint per vendor per call, a parked
// credential skipped before dispatch, and a paid run that may have started
// stops the chain rather than starting another.

import type { LLMToolDefinition } from '../llm/types';
import {
  discoverCapabilities,
  type CapabilityMode,
  type DiscoveryResult,
  type ScoredCandidate,
} from '../capability-discovery';
import {
  executeVendorTool,
  capabilityRequiresApproval,
  capabilityIsAffirmativeRead,
  type VendorToolRunResult,
} from '../capability-discovery/vendor-execution';
import {
  mintCapabilityHandle,
  resolveCapabilityHandle,
  isExecutableRef,
  type CapabilityTailEntry,
} from '../capability-discovery/handles';
import { bucketById } from '../capability-discovery/capability-tree';
import { log } from '../infrastructure/logging';
import {
  apifyPlatformConfigured,
  fetchApifyActorInputFields,
  fetchApifyActorInputSchema,
} from '../capability-discovery/apify-executor';
import { renderArgsHint, summarizeArgs, type ArgSummary } from '../capability-discovery/args-hint';
import { fetchConnectorFunctions } from '../connectors/connector-type-registry';
import { credentialCooling, resolveCredentialMap, type CredentialResolver } from '../capability-discovery/credential-scope';
import { isCooling } from '../capability-discovery/vendor-gate';
import { isEmptyCapabilityResult } from '../capability-discovery/empty-result';
import { type DatasetScope } from '../datasets/store';
// Parking is one rule for every surface now (datasets/park.ts): this module is
// a caller of it rather than its only owner.
import { parkOrInline } from '../datasets/park';
import { validateArgsAgainstSchema } from '../capability-discovery/args-validate';

export const CAPABILITY_SEARCH_TOOL = 'capability_search';
export const RUN_CAPABILITY_TOOL = 'run_capability';

export const capabilitySearchTool: LLMToolDefinition = {
  name: CAPABILITY_SEARCH_TOOL,
  description:
    'Find the best available building blocks for a data or automation need — connector tools, '
    + 'platform web tools, and proven external automations — ranked by fit, health, cost, and '
    + 'real usage evidence. Search here FIRST when the need names a site or service whose data '
    + 'is already served here, when the answer must carry particular fields, or when it must be '
    + 'complete rather than a representative sample. Read the open web instead for a one-off page '
    + 'or a general question no catalog would carry. Specify the need precisely; the mode matters: '
    + "'public_data' for third-party or competitor information from the public web, "
    + "'own_account' for the workspace's own systems. Results are capabilities, not vendors — "
    + 'run one with run_capability using the capabilityId it returns.',
  input_schema: {
    type: 'object',
    properties: {
      targetSystem: { type: 'string', description: 'Platform the data lives on, lowercase, e.g. instagram, zillow. Omit when unknown.' },
      operation: { type: 'string', description: 'Verb phrase, e.g. "search posts", "enrich person"' },
      entity: { type: 'string', description: 'What comes back, e.g. posts, profiles, listings' },
      mode: { type: 'string', enum: ['public_data', 'own_account'] },
      availableInputs: { type: 'array', items: { type: 'string' }, description: 'What you can supply, e.g. search_terms, profile_urls' },
      requiredOutputFields: { type: 'array', items: { type: 'string' }, description: 'Fields the answer must carry' },
    },
    required: ['operation', 'entity', 'mode'],
  },
};

export const runCapabilityTool: LLMToolDefinition = {
  name: RUN_CAPABILITY_TOOL,
  description:
    'Run one capability that capability_search returned. Pass its capabilityId (exactly as given) '
    + 'and the arguments the capability needs. Costs are metered to the workspace in Operating '
    + 'Units; a refusal explains itself and is final for this turn — never retry a refusal verbatim. '
    + 'A small result comes back whole. A large one is kept as a dataset and you get its id, its '
    + 'fields and a sample: read it with dataset_query and dataset_extract, which return only what '
    + 'you ask for; the fetch is not charged again (dataset_query and dataset_list use no model; '
    + 'dataset_extract uses the model and is metered like any answer). Never re-run a capability '
    + "to see more of a result it already returned. To add a further run's records to a dataset "
    + 'you already have (the same kind of records for another target), pass its id as appendTo.',
  input_schema: {
    type: 'object',
    properties: {
      capabilityId: { type: 'string', description: 'The capabilityId from a capability_search result (e.g. cap_ab12…). Opaque; do not construct one.' },
      args: { type: 'object', description: 'Arguments for the capability, per the args it listed.' },
      appendTo: { type: 'string', description: "A dataset id from an earlier run: this run's records are added to it (each marked with its _run number) instead of starting a new dataset." },
    },
    required: ['capabilityId'],
  },
};

/** The model-facing name of what a run fetched: the action, plus the
 *  arguments the model wrote (its own words, safe to echo). A store actor
 *  is named by its arguments alone — its reference is a vendor's. */
function datasetLabel(ref: string, args: Record<string, unknown>): string {
  const { connectorType, toolName } = splitRef(ref);
  const action = connectorType === 'apify' && toolName === 'run_actor' ? 'records' : actionLabel(ref);
  const bits = Object.entries(args)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .slice(0, 3)
    .map(([k, v]) => `${k} ${String(v).slice(0, 40)}`);
  return `${action}${bits.length ? `: ${bits.join(', ')}` : ''}`.slice(0, 120);
}

const MAX_RENDERED = 5;

/** The most arguments a handoff's hint names. Bounded so the text stays a
 *  hint; a candidate whose REQUIRED arguments do not all fit within it is not
 *  handed off, because the model would then be asked to guess the rest. */
const HANDOFF_HINT_ARGS = 12;

/** Vendor brand tokens to strip from the model-facing surface (search results
 *  and refusal text — all our own generated text, safe to scrub). Extending
 *  this set is part of onboarding a vendor, same discipline as the executor's
 *  vendor sets. Returned data content is NOT scrubbed, to preserve fidelity;
 *  a vendor whose response envelope names itself is a targeted follow-up. */
/** Which of the sites and services this platform already serves are named in a
 *  piece of text, lowercased and de-duplicated.
 *
 *  Read from the same list the scrubber uses, deliberately: a name worth
 *  hiding from the model is a name whose data is served here, so the two
 *  cannot drift apart. It is a keyword match and nothing more -- it says a
 *  question MENTIONED something in the catalog, never that a capability would
 *  have answered it well. That distinction is the whole point of measuring
 *  rather than assuming.
 *
 *  Its one caller is the turn audit, which pairs it with whether the catalog
 *  was actually searched. */
export function servedNamesIn(text: string): string[] {
  const hay = text.toLowerCase();
  const found = new Set<string>();
  for (const token of VENDOR_BRAND_TOKENS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(hay)) found.add(token);
  }
  return [...found];
}

export const VENDOR_BRAND_TOKENS = [
  'tikhub', 'apify', 'gloria', 'nasdaq', 'strale', 'crunchbase', 'contactout',
  'peopledatalabs', 'people data labs', 'pdl', 'hunterio', 'hunter.io', 'hunter', 'saperly',
  'google trends', 'google_trends', 'kadec0', 'ycombinator', 'y combinator', 'defillama', 'defi llama',
  // The resold public-data lane (connector-service generated/locus-parse.ts,
  // src/catalog/locus-parse-allowlist.ts brands): the same list the generator
  // prints, so a vendor's name never reaches the model from this surface.
  'aaa', 'accuweather', 'angel list', 'angellist', 'artificial analysis', 'artificialanalysis',
  'bid cars', 'bid.cars', 'bidcars', 'built in', 'builtin', 'capterra', 'carfax', 'cars com',
  'cars.com', 'chatbot arena', 'edmunds', 'finviz', 'g2', 'getapp', 'homes com', 'homes.com',
  'idealist', 'indeed', 'iqair', 'kbb', 'kelley blue book', 'levels fyi', 'levels.fyi',
  'lm arena', 'lmarena', 'loopnet', 'marketbeat', 'secform4', 'stockanalysis',
  'the companies api', 'thecompaniesapi', 'trustpilot', 'weather underground', 'web3 career',
  'web3.career', 'wellfound', 'wunderground', 'yahoo', 'yahoo finance', 'zestimate', 'zillow',
  // Generated into the resold lane; the generator
  // prints this list for exactly this purpose.
  'polymarket', 'hyperliquid',
];

function scrubVendorBrands(text: string): string {
  let out = text;
  for (const token of VENDOR_BRAND_TOKENS) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), 'a data source');
  }
  return out;
}

/** The action name, from the '<connectorType>:<functionName>' ref, with the
 *  connector type dropped — a function name is vendor-brand-free by nature
 *  (get_latest_news, get_stock_quote), so it names the action, not the vendor. */
function actionLabel(sourceRef: string): string {
  const fn = sourceRef.includes(':') ? sourceRef.slice(sourceRef.indexOf(':') + 1) : sourceRef;
  return fn.replace(/_/g, ' ').trim();
}

/** The top-level arguments from a candidate's input schema — name, type and
 *  whether required — for the model to know what to pass. The argument names
 *  are the capability's, not the vendor's. */
function argsHint(schema: unknown): string {
  return renderArgsHint(summarizeArgs(schema));
}

function splitRef(ref: string): { connectorType: string; toolName: string } {
  const i = ref.indexOf(':');
  return i > 0 ? { connectorType: ref.slice(0, i), toolName: ref.slice(i + 1) } : { connectorType: '', toolName: '' };
}

/** The vendor a capability runs on: the connector type of a registry
 *  function, the platform Apify account for a store actor. */
function vendorOfRef(ref: string): string {
  return splitRef(ref).connectorType;
}

export interface CapabilityDiscoveryOptions {
  /** Whether the credential THIS caller would run a vendor on is parked. */
  vendorCooling?: (connectorType: string) => boolean;
}

/** The discovery call behind runCapabilitySearch, returning the STRUCTURED
 *  ranked candidates (scores, judge verdicts, every factor) rather than the
 *  model-facing rendered string. The renderer below calls it; so does the
 *  internal route's calibration/debug branch, which needs the raw scores to
 *  tune the weak-fit threshold and health floors against a corpus of intents
 *  (no vendor execution, so it is free to run before any real traffic). It is
 *  service-authed and operator-only — never a model-facing surface — so it may
 *  carry vendor identity, unlike the rendered string. */
export async function runCapabilityDiscovery(
  tenantId: string,
  input: Record<string, unknown>,
  opts: CapabilityDiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const mode: CapabilityMode = input.mode === 'own_account' ? 'own_account' : 'public_data';
  return discoverCapabilities({
    tenantId,
    targetSystem: typeof input.targetSystem === 'string' ? input.targetSystem.toLowerCase() : undefined,
    operation: typeof input.operation === 'string' ? input.operation : 'search',
    entity: typeof input.entity === 'string' ? input.entity : 'records',
    mode,
    availableInputs: Array.isArray(input.availableInputs)
      ? input.availableInputs.filter((s): s is string => typeof s === 'string')
      : [],
    requiredOutputFields: Array.isArray(input.requiredOutputFields)
      ? input.requiredOutputFields.filter((s): s is string => typeof s === 'string')
      : [],
    // The assistant is not an agent with bindings; route preference treats
    // every connector candidate as platform_vendor.
    boundConnectorTypes: [],
  }, { vendorCooling: opts.vendorCooling });
}

/** One candidate the search will offer as a capabilityId, with everything
 *  the offer and the tails need to know about it. */
interface OfferedCandidate {
  candidate: ScoredCandidate;
  /** What the executor runs: '<connectorType>:<fn>', or 'apify:run_actor'. */
  ref: string;
  vendor: string;
  /** Server-set arguments that ride on the handle: the actor id for a store actor. */
  presetArgs?: Record<string, unknown>;
  requiresApproval: boolean;
  /** Affirmatively a read, per the reviewed registry or the actor-read row. */
  readOnly: boolean;
  /** Fit enough to replace another candidate for the same need without the
   *  model choosing it. */
  fit: boolean;
  /** The rendered line's argument hint. */
  hint: string;
}

/** Whether a judge verdict is a good enough fit for AUTOMATIC replacement.
 *  Being in the top five is not that: a weak or partial fit was ranked
 *  because nothing better existed, and running it in place of the candidate
 *  the model chose would answer the need with something the judge itself
 *  called partial. */
function fitForReplacement(c: ScoredCandidate, requiredOutputFields: string[]): boolean {
  if (c.judge.capabilityMatch < 2) return false;
  if (!c.judge.shapeMatch) return false;
  if (requiredOutputFields.length > 0 && c.judge.outputCovers !== 'yes') return false;
  return true;
}

/** Whether a candidate may sit in another candidate's tail. Executable,
 *  offered, affirmatively a read, not held for approval, a good fit, and on
 *  the same mode as the request (every candidate of one search is; stated so
 *  it stays true if that ever changes). */
function tailEligible(o: OfferedCandidate, mode: CapabilityMode): boolean {
  return isExecutableRef(o.ref) && o.readOnly && !o.requiresApproval && o.fit && o.candidate.mode === mode;
}

/** The tail for the candidate at `index`: the other eligible candidates, other
 *  vendors first in rank order, then the same vendor's remaining entries in
 *  rank order. A vendor that just failed tends to fail across its endpoints;
 *  the next vendor is the better bet, and the chain only spends one attempt
 *  per vendor per call in any case. */
function tailFor(offered: OfferedCandidate[], index: number, mode: CapabilityMode): CapabilityTailEntry[] {
  const self = offered[index];
  const rest = offered.filter((o, i) => i !== index && tailEligible(o, mode));
  const ordered = [...rest.filter((o) => o.vendor !== self.vendor), ...rest.filter((o) => o.vendor === self.vendor)];
  return ordered.map((o) => ({ ref: o.ref, ...(o.presetArgs ? { presetArgs: o.presetArgs } : {}) }));
}

export async function runCapabilitySearch(
  tenantId: string,
  input: Record<string, unknown>,
  /** The account of the person behind this search, when there is one, so the
   *  vendors are judged on the credentials THEIR run would use: a workspace
   *  connector of the vendor's type when connected, else the platform key.
   *  Absent — an autonomous run, a caller with no person — every vendor is
   *  judged on the platform credential, which is what such a run executes
   *  on. Never read from the model's arguments: the callers supply it from
   *  server-side context. */
  accountId?: string,
): Promise<string> {
  // Resolved ONCE per search, with the same rule execution applies per call
  // (credential-scope.ts), so what search hides is what the run would refuse.
  const credentials: CredentialResolver = await resolveCredentialMap(tenantId, accountId);
  const vendorCooling = (connectorType: string): boolean => credentialCooling(connectorType, credentials(connectorType), isCooling);
  const result = await runCapabilityDiscovery(tenantId, input, { vendorCooling });

  if (result.candidates.length === 0) {
    return result.degraded
      ? 'Discovery was degraded (a source timed out); nothing reliable came back. Fall back to the platform web tools.'
      : 'Nothing in the platform surface fits that need well. Fall back to the platform web tools, and note the gap.';
  }

  const top = result.candidates.slice(0, MAX_RENDERED);
  const mode = result.spec.mode;
  const requiredOutputFields = result.spec.requiredOutputFields ?? [];

  // Apify Store actors (blueprint route) are runnable, platform-funded scraping
  // capabilities: the actor id rides on the handle as a preset arg (never on the
  // model boundary), and run_capability routes it to the apify:run_actor
  // executor. Gated on the platform Apify account being configured. Pre-fetch
  // each actor's input fields (best-effort, cached) so the arg hint is real.
  const apifyOn = apifyPlatformConfigured();
  const apifyInputFields = new Map<string, ArgSummary[]>();
  if (apifyOn) {
    await Promise.all(
      top
        .filter((c) => c.route === 'blueprint' && c.source === 'apify_store')
        .map(async (c) => {
          apifyInputFields.set(c.sourceRef, await fetchApifyActorInputFields(c.sourceRef));
        }),
    );
  }

  // Pre-classify each runnable candidate's approval class (the lookup is async;
  // the render loop below is not). A write/outbound-class capability mints a
  // handle carrying the approval marker, so the runtime's admission gate pauses
  // for a human before an agent runs it. And, separately, whether each is
  // AFFIRMATIVELY a read — the standard for sitting in another's tail.
  const approvalByRef = new Map<string, boolean>();
  const readOnlyByRef = new Map<string, boolean>();
  await Promise.all(
    top
      .filter((c) => c.route === 'platform_vendor' && isExecutableRef(c.sourceRef))
      .map(async (c) => {
        const [approval, readOnly] = await Promise.all([
          capabilityRequiresApproval(c.sourceRef),
          capabilityIsAffirmativeRead(c.sourceRef),
        ]);
        approvalByRef.set(c.sourceRef, approval);
        readOnlyByRef.set(c.sourceRef, readOnly);
      }),
  );
  const [apifyRunActorApproval, apifyRunActorReadOnly] = apifyOn
    ? await Promise.all([capabilityRequiresApproval('apify:run_actor'), capabilityIsAffirmativeRead('apify:run_actor')])
    : [false, false];

  // What each connector function takes, from the registry that implements it,
  // so the args hint names real arguments with their types. Discovery ranks
  // functions by name and carries no schema for them; the schema is fetched
  // here, once per connector among the candidates offered.
  const connectorFunctions = new Map<string, Awaited<ReturnType<typeof fetchConnectorFunctions>>>();
  await Promise.all(
    [...new Set(top.filter((c) => c.route === 'platform_vendor' && !c.inputSchema && c.connectorType).map((c) => c.connectorType as string))]
      .map(async (type) => { connectorFunctions.set(type, await fetchConnectorFunctions(type)); }),
  );
  const schemaFor = (c: ScoredCandidate): unknown => {
    if (c.inputSchema) return c.inputSchema;
    const fn = c.sourceRef.includes(':') ? c.sourceRef.slice(c.sourceRef.indexOf(':') + 1) : '';
    return connectorFunctions.get(c.connectorType ?? '')?.find((f) => f.name === fn)?.inputSchema;
  };

  // The candidates that will be offered as a capabilityId, in rank order.
  // Native tools are listed but not offered (the model already has them), and
  // non-Apify blueprint candidates are advisory prior art for agent-building.
  const offered: OfferedCandidate[] = [];
  for (const c of top) {
    if (c.route === 'platform_vendor') {
      // A reference with no function cannot be run; offering it as a
      // capabilityId would hand the model — and a person asked to approve it —
      // something that skips silently at execution. Left out, and logged.
      if (!isExecutableRef(c.sourceRef)) {
        log.warn({ tenantId, sourceRef: c.sourceRef, connectorType: c.connectorType }, 'capability discovery: candidate names no function; not offered');
        continue;
      }
      offered.push({
        candidate: c,
        ref: c.sourceRef,
        vendor: c.connectorType ?? vendorOfRef(c.sourceRef),
        requiresApproval: approvalByRef.get(c.sourceRef) ?? true,
        readOnly: readOnlyByRef.get(c.sourceRef) ?? false,
        fit: fitForReplacement(c, requiredOutputFields),
        hint: argsHint(schemaFor(c)),
      });
    } else if (apifyOn && c.route === 'blueprint' && c.source === 'apify_store') {
      offered.push({
        candidate: c,
        ref: 'apify:run_actor',
        vendor: 'apify',
        presetArgs: { actorId: c.sourceRef },
        requiresApproval: apifyRunActorApproval,
        readOnly: apifyRunActorReadOnly,
        fit: fitForReplacement(c, requiredOutputFields),
        hint: renderArgsHint((apifyInputFields.get(c.sourceRef) ?? []).slice(0, 8)),
      });
    }
  }

  const lines: string[] = [];
  for (const c of top) {
    const index = offered.findIndex((o) => o.candidate === c);
    if (index >= 0) {
      const o = offered[index];
      // A write-class handle keeps an empty tail: a person approves ONE
      // operation on ONE target. So does a primary that is not affirmatively
      // a read — an automatic continuation is only ever a read's business.
      const tail = o.requiresApproval || !o.readOnly ? [] : tailFor(offered, index, mode);
      const handle = mintCapabilityHandle(o.ref, tail, o.presetArgs, o.requiresApproval);
      const bucket = bucketById(c.capabilityBucket);
      const category = bucket ? `[${bucket.displayName}] ` : '';
      // Vendor-safe: for a store actor the actor name is NOT rendered (it can
      // carry a vendor or author brand); the label is the bucket plus the
      // judge's scrubbed reason.
      const label = o.ref === 'apify:run_actor' ? '' : `${actionLabel(c.sourceRef)}: `;
      const body = scrubVendorBrands(`- ${category}${label}${c.judge.reason}${o.hint}`);
      lines.push(`${body} (capabilityId: ${handle})`);
    } else if (c.route === 'native_tool') {
      lines.push(`- ${c.sourceRef}: ${scrubVendorBrands(c.judge.reason)} (a tool you already have)`);
    }
    // Other blueprint candidates (non-Apify) remain advisory prior-art for
    // agent-building, not runnable from this surface — omitted here.
  }

  if (lines.length === 0) {
    return 'Nothing runnable fits that need directly; fall back to the platform web tools.';
  }
  return `Ranked building blocks (run one with run_capability, passing its capabilityId):\n${lines.join('\n')}`;
}

export interface RunCapabilityOptions {
  /** Who is running it. Defaults to the in-process Liftoff assistant, which has
   *  no approval flow and so cannot run write/outbound-class capabilities. The
   *  internal route sets 'agent' or 'caio'. */
  caller?: 'assistant' | 'caio' | 'agent';
  /** `internal_agents.id` of the agent running this, when the caller sends
   *  it. Only the 'agent' caller has one — the assistants have no agent row,
   *  and are attributed by surface instead. Optional: a call without it books
   *  exactly as before and reports as unattributed, which is the truth until
   *  the runtime sends it. */
  agentId?: string;
  /** True only when the agent path has a human approval for THIS call from the
   *  runtime's admission gate. The sole key that lets a write-class capability
   *  execute; never derived from the model's arguments. */
  approved?: boolean;
  /** The caller's identity for THIS act, carried to the connector boundary so
   *  a repeat of the same act in the same run is replayed there, never run
   *  twice. Absent for the in-process assistant, which mints its own. Carried
   *  to the PRIMARY attempt only: a continuation is a distinct request, and a
   *  key that names one act must not be replayed onto another. */
  idempotencyKey?: string;
  /** The job the call belongs to — the conversation or the run — which is
   *  where a large result is parked as a dataset. Absent, results are
   *  parked unscoped: readable by id, listed by nobody. */
  scope?: DatasetScope;
}

/** What running a capability produced: the model-facing text either way, and
 *  the truth of whether it ran and whether it ANSWERED. `empty` on a success
 *  says the source ran and returned nothing usable (every candidate did, or
 *  none was left to try); a caller counting useful results counts
 *  `ok && !empty`. The text on failure names no cause and no vendor — with
 *  two exceptions. When the source rejected the ARGUMENTS, the text carries
 *  its account of what is wrong, because that is the one failure the model
 *  can put right, and the one it cannot put right blind. And a HANDOFF names
 *  the next candidate for the same need — a fresh handle and the arguments
 *  it takes — so the model's next call is one directed turn with the right
 *  names rather than a guess. Neither names a vendor or a cause. The
 *  operator logs written here carry every reason. */
export type RunCapabilityOutcome =
  | { ok: true; text: string; empty: boolean }
  | { ok: false; kind: 'refused' | 'requires_approval' | 'no_result' | 'invalid_arguments' | 'handoff' | 'unfunded'; text: string };

function argumentsRejectedText(reason: string): string {
  return `This capability did not run: it rejected the arguments — ${scrubVendorBrands(reason).trim()}. Correct the arguments per the args the search listed and run the same capabilityId again. Do not name or guess the provider behind it.`;
}

function handoffText(hint: string, handle: string): string {
  const takes = hint ? `takes: ${hint}` : 'takes no arguments';
  return scrubVendorBrands(
    `This capability did not return a result. The next best for the same need ${takes}; call run_capability with capabilityId ${handle}, mapping your values onto those argument names. If none of these fits, use the web tools you already have. Do not name or guess the provider behind it.`,
  );
}

const NEUTRAL_NO_RESULT =
  'This capability did not return a result. If another capability from the search, or a tool you already have (the web tools, the browser), can meet the same need, use that now rather than reporting failure. If nothing can, report that plainly and do not state, guess, or speculate about a cause — a provider, credits, a balance, a limit, an outage, or a missing account — and do not name the provider behind it.';
const NEUTRAL_NEEDS_APPROVAL =
  'This capability was not run: it needs human approval that this surface cannot request. Report that plainly and do not name or guess the provider behind it.';

/** One attempt's record for the operator log. */
interface Attempt {
  ref: string;
  reason: string;
  requiresApproval: boolean;
}

/** The two schemas a candidate is judged by. They are the same object for
 *  almost every source; they differ only where a reseller enforces a
 *  constraint the vendor behind it does not. */
interface CandidateSchemas {
  /** What the SOURCE will accept — the routing schema where there is one.
   *  The question "would this call be refused" is asked of this. */
  routing: unknown;
  /** What the MODEL was offered. The question "did the model write bad
   *  arguments" is asked of this, and only of this: a value the model was
   *  invited to send is not the model's mistake, whatever a reseller does
   *  with it. */
  modelFacing: unknown;
}

/** The complete input schemas a candidate declares, for validating the
 *  model's arguments before running it automatically. Null when they cannot
 *  be had, and null never authorises an automatic run.
 *
 *  A reseller can enforce a narrower schema than the vendor behind it — a
 *  Parse scraper's five test cities, published as a domain and turned into a
 *  hard enum — so "what may be asked for" and "what this source will take"
 *  are two different questions with two different answers, and the caller
 *  needs both: one decides whether to spend the call, the other decides what
 *  to tell the model when nothing could take it. */
async function candidateSchemas(entry: CapabilityTailEntry): Promise<CandidateSchemas | null> {
  const { connectorType, toolName } = splitRef(entry.ref);
  if (connectorType === 'apify' && toolName === 'run_actor') {
    const actorId = entry.presetArgs && typeof entry.presetArgs.actorId === 'string' ? entry.presetArgs.actorId : '';
    const schema = actorId ? await fetchApifyActorInputSchema(actorId) : null;
    return schema === null ? null : { routing: schema, modelFacing: schema };
  }
  const fn = (await fetchConnectorFunctions(connectorType)).find((f) => f.name === toolName);
  if (!fn?.inputSchema) return null;
  return { routing: fn.routingSchema ?? fn.inputSchema, modelFacing: fn.inputSchema };
}

/** The schema an automatic candidate must accept before it is run: what the
 *  source will take. Used for the primary and the tail alike, so the same
 *  source is judged the same way wherever it appears. */
async function completeSchemaFor(entry: CapabilityTailEntry): Promise<unknown | null> {
  return (await candidateSchemas(entry))?.routing ?? null;
}

/** The hint a handoff carries for a candidate, or null when the schema cannot
 *  name every required argument within the bound — then the candidate is
 *  skipped rather than the model asked to guess. */
function boundedHint(schema: unknown): string | null {
  const all = summarizeArgs(schema, Number.MAX_SAFE_INTEGER);
  const shown = all.slice(0, HANDOFF_HINT_ARGS);
  const requiredShown = shown.filter((a) => a.required).length;
  const requiredAll = all.filter((a) => a.required).length;
  if (requiredShown < requiredAll) return null;
  return renderArgsHint(shown).replace(/^; args: /, '');
}

export async function runCapability(
  tenantId: string,
  accountId: string,
  input: Record<string, unknown>,
  opts: RunCapabilityOptions = {},
): Promise<RunCapabilityOutcome> {
  const capabilityId = typeof input.capabilityId === 'string' ? input.capabilityId : '';
  const handle = resolveCapabilityHandle(capabilityId);
  if (!handle) {
    return {
      ok: false,
      kind: 'refused',
      text: 'That capabilityId is not valid or has expired. Run capability_search again and use a capabilityId from the fresh results.',
    };
  }
  const args = readCapabilityArgs(input);
  const caller = opts.caller ?? 'assistant';
  const scope: DatasetScope = opts.scope ?? { kind: 'unscoped', id: '' };
  const appendTo = typeof input.appendTo === 'string' && input.appendTo.trim() ? input.appendTo.trim() : null;

  // A write/outbound-class capability is run once, against the reference the
  // handle names — never a continuation. A person approved ONE operation on
  // ONE target; a refusal must not turn into a different function or a
  // different mailbox under the same approval. Read-class capabilities keep
  // the directed continuation below.
  const writeClass = capabilityId.startsWith('cap_w.');
  // "No usable records" is a question about a READ: a list that came back
  // empty, a wrapper with nothing in it. A write's confirmation — however
  // small, `{ status: 'sent' }` — is its answer, and calling it empty would
  // report a completed send as a miss. Decided from the TRUE class, re-read
  // here, not from the handle's marker: the marker is a hint the runtime
  // reads, and a classification can drift in the thirty minutes a handle
  // lives. A primary that is not affirmatively a read also walks no tail,
  // whatever the handle carries — a continuation is only ever a read's.
  const primaryIsRead = !writeClass && await capabilityIsAffirmativeRead(handle.primaryRef);
  const continuation = primaryIsRead && opts.approved !== true;
  const tail: CapabilityTailEntry[] = continuation ? handle.fallbacks : [];

  // The credentials each vendor would run on for this caller, resolved once
  // here for the pre-dispatch cooling check on tail entries; the executor
  // re-resolves per call with the same rule and skips a parked credential
  // itself, so the two cannot disagree.
  const credentials = await resolveCredentialMap(tenantId, accountId || undefined);

  const attempts: Attempt[] = [];
  /** Vendors this call has spent its one attempt on — a failure or an empty
   *  answer — whose remaining endpoints are omitted from this call and from
   *  any handoff it mints. */
  const attemptedVendors = new Set<string>();
  let sawRequiresApproval = false;
  let sawEmpty = false;
  /** Why the capability the model CHOSE could not take the arguments it
   *  wrote, when the schema that rejected them is the one the model was
   *  offered. Set only in that case, and it is what the model is told if
   *  nothing else answers: a skipped first choice must not come back as a
   *  blank "no result" when the model could have fixed it in one turn. */
  let primaryArgumentsRejected: string | null = null;

  const finish = (): RunCapabilityOutcome => {
    // The operator record: which references were resolved, which were tried,
    // and why each declined. These can name a vendor; the model-facing text
    // below never does.
    log.info(
      {
        event: 'capability_run_no_result',
        tenantId,
        caller,
        approved: opts.approved === true,
        hasAccount: Boolean(accountId),
        writeClass,
        primaryRef: handle.primaryRef,
        tail: tail.map((e) => e.ref),
        attemptedVendors: [...attemptedVendors],
        attempts,
        sawEmpty,
      },
      'capability run produced no result',
    );
    // A write/outbound-class capability the caller could not approve. The agent
    // path pauses BEFORE reaching here (its handle marker trips the admission
    // gate), so this is what the in-process assistant and the CAIO see — they
    // have no approval flow, and the phrasing marks it final, not retryable.
    if (sawRequiresApproval) {
      return { ok: false, kind: 'requires_approval', text: NEUTRAL_NEEDS_APPROVAL };
    }
    // A source ran and answered nothing, and no candidate is left to try:
    // the truthful outcome is a success that is empty. The text is the
    // neutral no-result line — the model's instruction is the same either
    // way, and the flag is what a caller counting answers reads.
    if (sawEmpty) {
      return { ok: true, empty: true, text: NEUTRAL_NO_RESULT };
    }
    // The capability the model chose could not take the arguments it wrote,
    // nothing else could either, and the schema that said so is the one the
    // model was offered. That is the model's to fix and it is told, exactly
    // as it would have been had the source rejected them on the wire — the
    // difference is that no call was spent finding out. The validator's
    // account names the argument and what is wrong with it and never quotes
    // a value, so no source's private list of accepted values reaches the
    // model this way.
    if (primaryArgumentsRejected !== null) {
      return { ok: false, kind: 'invalid_arguments', text: argumentsRejectedText(primaryArgumentsRejected) };
    }
    // Neutral by design: state NO cause. The real reason (which can name the
    // vendor, and is often a transport/config failure rather than anything the
    // model could infer) lives in the operator log above, not here. A stated
    // cause is exactly what the model then repeats or embellishes.
    return { ok: false, kind: attempts.length > 0 ? 'refused' : 'no_result', text: NEUTRAL_NO_RESULT };
  };

  /** Run one reference and fold its outcome into this call's state. Returns
   *  the final outcome when the chain must end here — an answer, an argument
   *  rejection of the primary, a run that is not safe to continue past — or
   *  null to go on to the next entry. */
  const attempt = async (
    entry: CapabilityTailEntry,
    isPrimary: boolean,
    /** Whether this entry is a read, so an empty answer is a miss to move
     *  past rather than the confirmation a write returns. The primary's is
     *  its true class; a tail entry's is re-checked before it runs. */
    isRead: boolean,
  ): Promise<RunCapabilityOutcome | null> => {
    const { connectorType, toolName } = splitRef(entry.ref);
    if (!connectorType || !toolName) {
      // Minting refuses such a reference; reaching here means a handle from
      // before that guard. Recorded, never silent.
      attempts.push({ ref: entry.ref, reason: 'reference names no function', requiresApproval: false });
      return null;
    }
    // presetArgs (e.g. an Apify actor id) ride on the handle entry, never
    // from the model; the executor merges them and they only matter for the
    // apify:run_actor branch — a connector-function ref ignores them.
    const outcome: VendorToolRunResult = await executeVendorTool({
      tenantId,
      accountId,
      connectorType,
      toolName,
      args,
      presetArgs: entry.presetArgs,
      caller: opts.caller,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      approved: opts.approved,
      ...(isPrimary && opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    });
    if (outcome.success) {
      // A READ that carries nothing usable is not an answer: the source ran
      // (and was booked), the chain goes on — or, with nothing left to try,
      // the outcome is a truthful empty success. A write answers with what
      // it returned. Content that IS there is returned faithfully (not
      // scrubbed) — it is domain data, the deliverable. The vendor was
      // already hidden at the search surface, and the executor has already
      // rendered the result within its budget.
      if (isRead && isEmptyCapabilityResult(outcome.structuredContent)) {
        sawEmpty = true;
        attemptedVendors.add(connectorType);
        attempts.push({ ref: entry.ref, reason: 'ran and returned an empty result', requiresApproval: false });
        return null;
      }
      // A result larger than one message is parked as a dataset and the
      // model gets its view — so it never runs the capability again for
      // records it already has, and never reads them all either.
      const source = connectorType === 'apify' && entry.presetArgs && typeof entry.presetArgs.actorId === 'string'
        ? { source: 'apify_store', sourceRef: entry.presetArgs.actorId }
        : { source: 'connector_registry', sourceRef: entry.ref };
      return {
        ok: true,
        empty: false,
        text: await parkOrInline(tenantId, source, outcome.structuredContent, outcome.content, scope, datasetLabel(entry.ref, args), appendTo),
      };
    }
    if ('skipped' in outcome && outcome.skipped === 'cooling') {
      // Not an attempt against the vendor: nothing was dispatched.
      attempts.push({ ref: entry.ref, reason: 'credential cooling', requiresApproval: false });
      return null;
    }
    if ('skipped' in outcome && outcome.skipped === 'unfunded') {
      // The workspace cannot be admitted to spend the platform's money, and
      // that is a fact about the workspace, not the vendor: no fallback in the
      // tail is funded either, so the chain ends here. Nothing was dispatched
      // and nothing was paid. The reason is the person's own message.
      log.info(
        { event: 'capability_run_unfunded', tenantId, caller, primaryRef: handle.primaryRef, ref: entry.ref, reason: outcome.reason },
        'capability run refused: the workspace cannot be admitted to spend',
      );
      return { ok: false, kind: 'unfunded', text: outcome.reason };
    }
    if ('argumentsRejected' in outcome && outcome.argumentsRejected === true) {
      // The capability the model chose rejected the arguments it wrote. That
      // is the model's to fix, so it is told, and nothing else is tried: a
      // continuation run with those same arguments either fails the same way
      // or — worse — answers a different question with a result that looks
      // like one.
      if (isPrimary) {
        log.info(
          { event: 'capability_run_arguments_rejected', tenantId, caller, primaryRef: handle.primaryRef, reason: outcome.reason },
          'capability run rejected its arguments',
        );
        return { ok: false, kind: 'invalid_arguments', text: argumentsRejectedText(outcome.reason) };
      }
      // A continuation that validated and was still rejected is one attempt
      // among others: the vendor answered, and gets no second endpoint.
      attemptedVendors.add(connectorType);
      attempts.push({ ref: entry.ref, reason: outcome.reason, requiresApproval: false });
      return null;
    }
    const requiresApproval = 'requiresApproval' in outcome && outcome.requiresApproval === true;
    if (requiresApproval) sawRequiresApproval = true;
    attempts.push({ ref: entry.ref, reason: outcome.reason, requiresApproval });
    if (!requiresApproval) attemptedVendors.add(connectorType);
    if ('autoFailoverSafe' in outcome && outcome.autoFailoverSafe === false) {
      // A paid run may have started, or did and could not be seen through.
      // Starting another paid source from this call would spend twice for
      // one need; the chain ends here with a neutral, non-success outcome and
      // the run id already logged for the reconciler.
      log.warn(
        { event: 'capability_run_ambiguous_stop', tenantId, caller, ref: entry.ref, reason: outcome.reason },
        'capability run stopped: a paid run may have started and cannot be seen through',
      );
      return { ok: false, kind: 'refused', text: NEUTRAL_NO_RESULT };
    }
    return null;
  };

  const primaryEntry: CapabilityTailEntry = { ref: handle.primaryRef, presetArgs: handle.presetArgs };
  // THE FIRST CHOICE IS VALIDATED TOO, against what the source will actually
  // accept. It was dispatched unchecked while only the tail candidates were
  // validated, so a source that publishes a narrower schema than the vendor
  // behind it — a reseller's hard enum over a scraper's five test cities —
  // took the call, refused it in 126 milliseconds, charged nothing and ended
  // the turn. A candidate that cannot accept these arguments is skipped
  // WITHOUT A REQUEST and the continuation looks for one that can.
  //
  // WHOSE MISTAKE IT WAS is a second question, and it decides what the model
  // is told when nothing could take the call. Arguments that fail the schema
  // the MODEL was offered are the model's to fix, and it is told so — the one
  // failure it can put right, and the one it cannot put right blind.
  // Arguments that fail only the source's narrower schema are not a mistake
  // at all: the model sent what it was invited to send, and telling it
  // otherwise would teach it to narrow to five cities that the vendor behind
  // that source does not even enforce.
  const primarySchemas = await candidateSchemas(primaryEntry);
  const primaryFit = primarySchemas === null
    ? { valid: true as const }
    : validateArgsAgainstSchema(args, primarySchemas.routing);
  if (!primaryFit.valid && primarySchemas !== null) {
    const modelFit = validateArgsAgainstSchema(args, primarySchemas.modelFacing);
    if (!modelFit.valid) primaryArgumentsRejected = modelFit.reason;
    log.info(
      {
        event: 'capability_run_primary_skipped',
        tenantId,
        caller,
        primaryRef: handle.primaryRef,
        tail: tail.map((e) => e.ref),
        reason: primaryFit.reason,
        modelFacingReason: modelFit.valid ? null : modelFit.reason,
      },
      'capability run skipped its first choice: the source would refuse these arguments',
    );
    attempts.push({ ref: handle.primaryRef, reason: `arguments do not fit what the source accepts: ${primaryFit.reason}`, requiresApproval: false });
  }
  const primaryOutcome = primaryFit.valid ? await attempt(primaryEntry, true, primaryIsRead) : null;
  if (primaryOutcome) return primaryOutcome;

  // The directed continuation over the tail.
  for (let i = 0; i < tail.length; i++) {
    const entry = tail[i];
    const vendor = vendorOfRef(entry.ref);
    if (attemptedVendors.has(vendor)) {
      attempts.push({ ref: entry.ref, reason: 'vendor already attempted in this call', requiresApproval: false });
      continue;
    }
    // A parked credential is skipped before any work on the entry — the
    // executor checks again on its own resolution before dispatch.
    if (credentialCooling(vendor, credentials(vendor), isCooling)) {
      attempts.push({ ref: entry.ref, reason: 'credential cooling', requiresApproval: false });
      continue;
    }
    // The read class is re-read here, not trusted from the handle: a
    // classification that drifted since the mint must not turn an automatic
    // continuation into a mutation.
    if (!(await capabilityIsAffirmativeRead(entry.ref))) {
      attempts.push({ ref: entry.ref, reason: 'not affirmatively a read at run time', requiresApproval: false });
      continue;
    }
    const schema = await completeSchemaFor(entry);
    if (schema === null) {
      // No complete schema: nothing can be validated, so nothing runs
      // automatically and nothing can be hinted completely. Skipped.
      attempts.push({ ref: entry.ref, reason: 'no complete input schema', requiresApproval: false });
      continue;
    }
    const validation = validateArgsAgainstSchema(args, schema);
    if (validation.valid) {
      const outcome = await attempt(entry, false, true);
      if (outcome) return outcome;
      continue;
    }
    // The arguments do not fit this candidate as they are. Hand the model
    // the candidate and what it takes, with the rest of the tail — minus the
    // vendors this call already spent — as the fresh handle's own tail.
    const hint = boundedHint(schema);
    if (hint === null) {
      attempts.push({ ref: entry.ref, reason: 'schema cannot state every required argument within the hint bound', requiresApproval: false });
      continue;
    }
    const remaining = tail.slice(i + 1).filter((e) => !attemptedVendors.has(vendorOfRef(e.ref)));
    const fresh = mintCapabilityHandle(entry.ref, remaining, entry.presetArgs, false);
    log.info(
      {
        event: 'capability_run_handoff',
        tenantId,
        caller,
        primaryRef: handle.primaryRef,
        handoffRef: entry.ref,
        remainingTail: remaining.map((e) => e.ref),
        attemptedVendors: [...attemptedVendors],
        attempts,
        reason: validation.reason,
      },
      'capability run handed the model the next candidate for the same need',
    );
    return { ok: false, kind: 'handoff', text: handoffText(hint, fresh) };
  }

  return finish();
}

/** The capability's call arguments, in whatever shape the caller sent them.
 *  The schema declares `args` as an object; a model carries the same content
 *  in three observed shapes: under `args`, under `arguments` (an object or a
 *  JSON-encoded string), or flattened at the top level beside `capabilityId`.
 *  Read only — the input is never reshaped. */
function readCapabilityArgs(input: Record<string, unknown>): Record<string, unknown> {
  const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (isPlainObject(input.args) && Object.keys(input.args).length > 0) return input.args;
  const alt = input.arguments;
  if (isPlainObject(alt)) return alt;
  if (typeof alt === 'string' && alt.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(alt);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Not JSON: no arguments to read.
    }
    return {};
  }
  // Flattened: everything that is not the handle or a control field is an
  // argument. The route defaults an absent `args` to {}, so an empty object
  // is treated as absent. A key carrying no value is not an argument either:
  // sent on, it reaches the vendor as null, and a schema that admits no
  // extra property refuses the whole call.
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (CONTROL_KEYS.has(key) || value === undefined) continue;
    flattened[key] = value;
  }
  return flattened;
}

/** The keys of a run_capability input that address the call rather than
 *  the capability: never forwarded as arguments. */
const CONTROL_KEYS: ReadonlySet<string> = new Set(['capabilityId', 'args', 'arguments', 'appendTo']);
