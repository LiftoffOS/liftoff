// Capability discovery — vendor tool execution.
//
// The ONE dispatch path for running a data-vendor tool from platform-backend
// (today: the Liftoff assistant). Execution goes through connector-service's
// Execute RPC — the SAME dispatcher, executors, credential handling, secret
// scrubbing, and response-conformance machinery every agent tool call uses —
// addressed with the `internal:<type>` instance form for platform-funded
// vendors that have no per-tenant connector row. One execution path in the
// estate, not a second one to guard separately.
//
// Enforcement lives HERE, before transport: the runtime once had enforcement
// only in its mcp-bridge while other dispatch paths ran unguarded, and that
// class of hole is exactly what a new dispatch surface must not reopen.
// Refusals are typed { success: false, reason } — never a fabricated success
// string (INV-PB-004).
//
// Credential model: platform keys are the default and
// resolve inside connector-service's executors. Tenant BYO keys ride the
// ordinary connector-instance path. crunchbase/contactout (BYO-only vendors,
// no platform key by decision) answer unavailable here rather than pretending
// a platform fallback exists.

import { create, type JsonObject } from '@bufbuild/protobuf';
import { checkExecutionAllowed } from '../billing/execution-guard';
import { ExecuteRequestSchema } from '@liftoffos/proto-gen/dist/liftoff/connector/v1/connector_service_pb';
import { randomUUID } from 'crypto';
import { toolClassifier } from '../mcp/tool-classifier';
import {
  getCatalog,
  getConnectorServiceClient,
  listConnectorsForTenant,
} from '../connectors/connector-service-client';
import { fetchConnectorFunctions, fetchRegistry } from '../connectors/connector-type-registry';
import { log } from '../infrastructure/logging';
import { ingestEventWithBuckets, resolveAccountIdForTenant } from '../cost-attribution/repository';
import { recordUsageEvidence } from './evidence';
import { runApifyActor } from './apify-executor';
import { elevateBlueprintFromRun } from './probe-runner';
import { isCooling, parkCredential, platformVendorSwitchedOff, type CooldownReason } from './vendor-gate';
import { credentialRefFor, selectConnectedConnector } from './credential-scope';
import { CREDENTIAL_COOLDOWN_MS } from './config';
import { fireAndForget } from '../shared/fire-and-forget';
import { listOf, renderCapabilityResult } from './result-rendering';

/** How many records a result carries — the answer to "how much did that
 *  call return", which the evidence row and the cost log both state so the
 *  question is answerable from the ledger. null for a non-list result. */
function recordCountOf(value: unknown): number | null {
  const list = listOf(value);
  return list ? list.items.length : null;
}
function itemsNote(count: number | null): string {
  return count === null ? '' : ` items=${count}`;
}
import { classifyError } from '@liftoffos/connector-types';

export interface VendorToolRunInput {
  tenantId: string;
  /** The calling account, needed to look up the tenant's own connectors so a
   *  connected vendor runs on the user's credential rather than the platform
   *  key. */
  accountId: string;
  connectorType: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Server-set arguments carried on the capability handle (never from the
   *  model). For an `apify:run_actor` capability this holds the actor id, which
   *  identifies the source and so must not cross the model boundary. */
  presetArgs?: Record<string, unknown>;
  /** Who is running this capability, which decides whether a write/outbound
   *  class tool may execute:
   *   - 'assistant' (default): the in-process Liftoff assistant, which has no
   *     approval flow — write-class always refuses.
   *   - 'caio': the Chief AI Officer, likewise no approval flow — refuses.
   *   - 'agent': a distilled agent in the tenant-runtime, which DOES pause for
   *     human approval at admission. Write-class executes only here, and only
   *     when `approved` is true. */
  caller?: 'assistant' | 'caio' | 'agent';
  /** `internal_agents.id` of the agent running this, when the caller knows
   *  it. Only the 'agent' caller has one; the assistants have no agent row by
   *  definition and are attributed by surface instead. Optional because the
   *  tenant runtime does not send it yet — a call without it books exactly as
   *  before and is reported as unattributed, which is the truth until it
   *  does. */
  agentId?: string;
  /** Identity of this act, supplied by a caller that keeps a ledger. Passed to
   *  connector-service as the Execute idempotency key, whose interceptor
   *  replays a repeated key with the same request and refuses one with a
   *  different request. Minted here when absent. */
  idempotencyKey?: string;
  /** Set true ONLY by the agent path after a human approved this exact call at
   *  the runtime's admission gate. It is the sole key that lets a write-class
   *  capability execute. Never settable from the model boundary. */
  approved?: boolean;
}

export type VendorToolRunResult =
  | {
      success: true;
      content: string;
      structuredContent?: unknown;
      costUsd?: number;
      /** The vendor's own record of the run that produced this result
       *  (`apify:run:<id>`), the same string the spend is booked under, so a
       *  trace can walk from the tool call to the ledger row to the vendor. */
      vendorRunRef?: string;
    }
  // Write/outbound-class capability reached without a human approval. Distinct
  // from a plain failure: the agent path turns this into an approval pause, and
  // it is the backstop that keeps an unapproved write from ever executing even
  // if the handle's class marker was stripped.
  | { success: false; requiresApproval: true; reason: string }
  // The source rejected the arguments themselves — a wrong type, a missing
  // field, two where one was wanted — and `reason` is its account of what is
  // wrong. Distinct from every other failure because the remedy is the
  // caller's: the same capability, called again with corrected arguments. A
  // different source tried with the same arguments would answer a different
  // question, or fail the same way.
  | { success: false; argumentsRejected: true; reason: string }
  // The credential this call would have run on is parked (vendor-gate.ts):
  // it answered 401 or payment-required within the last few minutes. Nothing
  // was dispatched and nothing was spent; the chain records the skip and
  // moves on.
  | { success: false; skipped: 'cooling'; reason: string }
  // The workspace cannot be admitted to spend the platform's money on this
  // call (billing/execution-guard.ts: suspended, or under the prepaid floor).
  // Nothing was dispatched and the vendor was not paid. The guard's reason is
  // the person's own message — what to do to continue.
  | { success: false; skipped: 'unfunded'; reason: string }
  | {
      success: false;
      reason: string;
      /** The CREDENTIAL failed, not this call: the wire classified an expired
       *  credential, or the vendor answered payment-required. The credential
       *  has been parked. Exclusive with argumentsRejected. */
      accountFailure?: 'auth' | 'payment';
      /** False when a paid vendor run may have started, or did start, and this
       *  call could not see it through — see ApifyActorRunResult. A caller must
       *  not start another paid source from that call. */
      autoFailoverSafe?: false;
    };

/** The booking key and trace reference of one Apify run. No slash: the ledger
 *  dedup treats `<key>/<suffix>` as the same booking's bucket rows. */
export function apifyRunRef(runId: string): string {
  return `apify:run:${runId}`;
}

/** Whether a connector-function failure is the arguments' fault. The wire's
 *  code is the authority when it names one; a code it could not classify is
 *  read from the message with the shared classifier, because a validation
 *  message from a vendor's own schema check reads like an internal error to
 *  the vendor-specific map. */
function argumentsRejectedOnWire(errorCode: string, error: string): boolean {
  if (errorCode === 'invalid_arguments') return true;
  if (errorCode && errorCode !== 'internal_error') return false;
  return classifyError({ message: error }) === 'invalid_arguments';
}

/** An EXPLICIT payment-required answer, and only that: the vendor's status
 *  line as connector-service's clients write it — 'tikhub <path> returned
 *  402', 'strale <slug> failed: 402 …' / 'failed: HTTP 402 …', a status in
 *  parentheses — or the payment words and vendor error codes
 *  (`payment_required`, `insufficient_credits`). A bare "402" elsewhere in a
 *  message (an id, a count, a line number) is not a status and parks nothing:
 *  the number is read only where a status is written. */
const PAYMENT_REQUIRED_RE = new RegExp([
  String.raw`\b(?:returned|http|status(?:\s*code)?:?|failed:|error:?)\s*402\b`,
  String.raw`\(402\)`,
  String.raw`\b402\s+payment\s+required\b`,
  String.raw`\bpayment[ _-]?required\b`,
  String.raw`\binsufficient[ _-]?(?:balance|credits?|funds)\b`,
  String.raw`\bcredits?[ _-]?exhausted\b`,
  String.raw`\bout[ _-]of[ _-]credits?\b`,
].join('|'), 'i');

/** Whether a connector-function failure is the CREDENTIAL's, and which way.
 *
 *  Exactly two signals park: `auth_expired`, the code connector-service gives
 *  a 401, and an explicit payment-required message the wire could not
 *  classify (there is no code for it yet; a 402 classifies internal_error).
 *  Nothing else does — `permission_denied` is a resource the key cannot
 *  reach, not a dead key; `rate_limited`, `vendor_unavailable` and a
 *  transport failure are per call; an argument rejection is the caller's, and
 *  is checked BEFORE this so a validation message that happens to quote a
 *  status never reads as a payment failure. A code the wire DID classify is
 *  the authority: the message is only read when there is no classification. */
function accountFailureOnWire(errorCode: string, error: string): CooldownReason | null {
  if (errorCode === 'auth_expired') return 'auth';
  if (errorCode && errorCode !== 'internal_error') return null;
  return PAYMENT_REQUIRED_RE.test(error) ? 'payment' : null;
}

/** Run a Store actor on the workspace's OWN Apify account through
 *  connector-service's native executor (`apify.run_actor` on that connector,
 *  same caps as the platform run). Booked tenant_key when it charged: the
 *  vendor part costs the workspace nothing in OUs. Answers the same shape the
 *  platform run does, plus `accountFailure` when the ACCOUNT (not the run)
 *  refused, so the caller can fall to the platform's rungs. */
async function runApifyOnWorkspaceAccount(args: {
  tenantId: string;
  connectorId: string;
  actorId: string;
  args: Record<string, unknown>;
  idempotencyKey?: string;
  started: number;
  /** Who is running it, threaded through so the workspace-account rung
   *  attributes its spend the same way the platform rungs do. A rung that
   *  books anonymously while its siblings do not is the shape of the defect
   *  this whole change removes. */
  agentId?: string;
  purpose?: string;
}): Promise<{ outcome: VendorToolRunResult; next: 'done' | 'platform_rungs'; park?: CooldownReason }> {
  const { tenantId, connectorId, actorId, started } = args;
  const idempotencyKey = args.idempotencyKey ?? randomUUID();
  let response;
  try {
    const client = getConnectorServiceClient();
    response = await client.execute(
      create(ExecuteRequestSchema, {
        tenantContext: { tenantId },
        connectorId,
        functionName: 'run_actor',
        input: { actorId, input: args.args as JsonObject, maxItems: APIFY_WORKSPACE_RUN_MAX_ITEMS, maxTotalChargeUsd: APIFY_WORKSPACE_RUN_MAX_CHARGE_USD } as JsonObject,
        idempotencyKey,
        traceId: randomUUID(),
      }),
      args.idempotencyKey ? { headers: { 'x-tenant-id': tenantId } } : undefined,
    );
  } catch (err) {
    // The transport to connector-service, not the vendor: the platform rungs
    // have their own path to the vendor, so this is worth falling through.
    log.warn({ err: (err as Error).message, tenantId, connectorId }, 'apify workspace-account run: connector-service unreachable');
    return { outcome: { success: false, reason: 'connector-service unreachable' }, next: 'platform_rungs' };
  }
  const latencyMs = Date.now() - started;
  const result = (response.result ?? {}) as { runId?: string; datasetId?: string | null; items?: unknown[] };
  const runId = typeof result.runId === 'string' ? result.runId : undefined;
  const costUsd = response.costUsd > 0 ? response.costUsd : undefined;
  if (costUsd !== undefined) {
    await bookVendorSpend({
      tenantId,
      connectorType: 'apify',
      toolName: 'run_actor',
      idempotencyKey: args.idempotencyKey ?? (runId ? apifyRunRef(runId) : idempotencyKey),
      costUsd,
      funding: response.fundingSource || 'tenant_key',
      startedAt: started,
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.purpose ? { purpose: args.purpose } : {}),
    });
  }
  await recordUsageEvidence({
    source: 'apify_store',
    sourceRef: actorId,
    tenantId,
    success: response.success,
    latencyMs,
    costUsd,
    outputNote: `${response.success ? 'ok' : 'vendor failure'} on the workspace account${runId ? ` ${apifyRunRef(runId)}` : ''}${itemsNote(recordCountOf(result.items))}`,
  });
  log.info(
    { metric: 'vendor_tool_cost', tenantId, connectorType: 'apify', toolName: 'run_actor', success: response.success, latencyMs, costUsd: costUsd ?? null, runId: runId ?? null, funding: response.fundingSource || 'tenant_key', connectorId, items: recordCountOf(result.items) },
    'vendor tool executed',
  );
  if (!response.success) {
    const error = response.error ?? 'the source could not be run';
    if (argumentsRejectedOnWire(response.errorCode, error)) {
      return { outcome: { success: false, argumentsRejected: true, reason: error }, next: 'done' };
    }
    const accountFailure = accountFailureOnWire(response.errorCode, error);
    if (accountFailure) return { outcome: { success: false, reason: error, accountFailure }, next: 'platform_rungs', park: accountFailure };
    // A run that started on the workspace's account and did not complete
    // cleanly is not safe to restart elsewhere: the account may be charged.
    return { outcome: { success: false, reason: error, ...(runId ? { autoFailoverSafe: false } : {}) }, next: 'done' };
  }
  const structured = Array.isArray(result.items) ? result.items : [];
  if (structured.length > 0 && runId) {
    fireAndForget(
      elevateBlueprintFromRun({ source: 'apify_store', sourceRef: actorId, items: structured, runId }),
      'capability blueprint elevation',
    );
  }
  return {
    outcome: {
      success: true,
      content: renderCapabilityResult(structured),
      structuredContent: structured,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(runId ? { vendorRunRef: apifyRunRef(runId) } : {}),
    },
    next: 'done',
  };
}

/** The same caps the platform run applies (apify-executor.ts). */
const APIFY_WORKSPACE_RUN_MAX_ITEMS = 100;
const APIFY_WORKSPACE_RUN_MAX_CHARGE_USD = (() => {
  const raw = Number(process.env.APIFY_MAX_RUN_CHARGE_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
})();

/** Vendors that run only on the tenant's OWN connected key — no platform
 *  credential exists for them, so an unconnected call refuses honestly instead
 *  of pretending a platform path. crunchbase/contactout are sales-gated by
 *  decision (their APIs require an enterprise contract, not a self-serve key).
 *  saperly is here because telephony is IDENTITY-BOUND: US A2P 10DLC
 *  registration must be under the workspace's own legal identity, the number
 *  and consent are theirs, and the monthly rental is theirs — there is no
 *  platform account to fall back to. A tenant that connects one runs on their
 *  credential via the ordinary connected-connector path (for saperly, its
 *  native MCP executor with the tenant key as the bearer). */
export const BYO_ONLY_VENDORS = new Set(['crunchbase', 'contactout', 'saperly', 'pdl', 'hunterio']);

/** Internal-tier vendors the platform funds; executable through the
 *  `internal:<type>` instance form. Extending this set is part of onboarding
 *  a platform-funded vendor. These are vendor-hidden, any-tenant data reads —
 *  telephony (saperly) is deliberately NOT here (see BYO_ONLY_VENDORS).
 *
 *  pdl and hunterio are BYO-only (above), NOT here: connector-service has no
 *  internal:<type> executor for them, so routing `internal:pdl`/`internal:hunterio`
 *  returns "no internal connector type" (ConnectError NOT_FOUND). Until CS
 *  ships a platform-key executor for them, they run only on a
 *  workspace's own connected key (the user-key-first path below), and listing
 *  them here would only produce a fast transport failure that reads as an outage.
 *
 *  google_trends and kadec0 are paid per call, but not always by the same
 *  purse: connector-service asks the platform's Vaaya balance first for an
 *  endpoint Vaaya resells (funding_source 'platform_key', the charge Vaaya
 *  reports) and the platform x402 wallet for the rest (funding_source
 *  'x402_wallet' and the settled amount). Whichever answers, funding_source is
 *  the authority and bookVendorSpend follows it; neither lane needs a rule
 *  here. Strale's platform lanes are the same two plus its own key. gloria's
 *  premium tools ride the wallet. browserbase_x402 is deliberately NOT here:
 *  it is the tenant runtime's last web-fetch rung, never a capability (and
 *  nothing resells the two endpoints it calls).
 *
 *  locus and vaaya are aggregators: the platform's own prepaid account at a
 *  reseller of key-based vendors (people and company enrichment, email find
 *  and verify, funding and hiring signals, public records). They fund as
 *  platform_key at the charge the aggregator reports, and sit behind a
 *  workspace's own connection to the underlying vendor for the same need. */
export const PLATFORM_EXECUTABLE_VENDORS = new Set(['tikhub', 'strale', 'nasdaq', 'gloria', 'google_trends', 'kadec0', 'locus', 'vaaya', 'ycombinator', 'defillama']);

/** Test-only views for the usage-invariant fitness function, which enumerates
 *  the vendor registry rather than a hand-written list — a vendor added to
 *  PLATFORM_EXECUTABLE_VENDORS without a usage path fails there at the point
 *  it is added. */
export const _PLATFORM_EXECUTABLE_VENDORS = PLATFORM_EXECUTABLE_VENDORS;
export const _BYO_ONLY_VENDORS = BYO_ONLY_VENDORS;

/** Sensitivity categories that must not execute from this surface without a
 *  human approval flow. Both consumers read this ONE set — capabilityRequiresApproval
 *  (mint time, which marks the handle cap_w. so the runtime's adapter gate pauses)
 *  and the executor below (which refuses an unapproved write) — so the class the
 *  handle advertises and the class the executor enforces cannot drift.
 *
 *  externalPublishing belongs here beside customerCommunication: it is the
 *  "External publishing (email, Slack, etc.)" oversight category — an OUTBOUND
 *  action that reaches outside the workspace, default-ON in the oversight UI just
 *  as financialActions/customerCommunication are. Its omission meant a Slack/email
 *  send capability minted a READ handle: the adapter gate never paused it and the
 *  executor let it through — an outbound publish with no approval. Reads carry no
 *  category (slack_search/list classify `{}`), so only the write/outbound tools
 *  are caught. */
const BLOCKED_CATEGORIES = new Set(['write', 'destructive', 'outbound', 'financialActions', 'customerCommunication', 'externalPublishing']);

/** The categories the gate reads for a function, and where they came from.
 *
 *  The classification cache answers first: it is where a reviewed or
 *  overridden classification lives. When it has no row, the connector
 *  registry's own categories for the function answer — the ones the
 *  function's author wrote, the same vocabulary the gate's blocked set names
 *  ('write', 'destructive', 'outbound'). The cache was hand-seeded per vendor
 *  and stops at the function names of its day, so a function added to the
 *  registry since was unrunnable for want of a row nobody had written, while
 *  its author's answer sat unread. Null when neither knows the function: the
 *  gate then stays closed. */
export async function gateCategoriesFor(
  connectorType: string | undefined,
  toolName: string,
): Promise<{ categories: string[]; source: 'classification' | 'registry' } | null> {
  const cached = await toolClassifier.getCachedClassification(toolName, connectorType).catch(() => null);
  if (cached) return { categories: cached.categories, source: 'classification' };
  if (!connectorType) return null;
  const fn = (await fetchConnectorFunctions(connectorType)).find((f) => f.name === toolName);
  if (!fn) return null;
  // A message into the workspace's own collaboration surface is how a team
  // talks to its people, and is never held — whatever else the function is
  // tagged. The runtime reads the same category the same way.
  if (fn.categories.includes('internalCollaboration')) return { categories: [], source: 'registry' };
  return { categories: fn.categories.flatMap((c) => REGISTRY_CATEGORY_AS_GATE[c] ?? []), source: 'registry' };
}

/** The registry's vocabulary in the gate's. A registry 'write' is an edit to
 *  the workspace's own data — a row appended, a tab added — which is what the
 *  classification rows the gate was written against call 'dataChanges', and
 *  do not hold: the person is in the conversation and asked for it. What the
 *  gate holds is what leaves the workspace or cannot be undone — 'outbound'
 *  and 'destructive' name themselves — and a read, sensitive or not, is not
 *  held at all. */
const REGISTRY_CATEGORY_AS_GATE: Record<string, string[]> = {
  read: [],
  sensitive: [],
  internalCollaboration: [],
  write: ['dataChanges'],
  destructive: ['destructive'],
  outbound: ['outbound'],
};

/** Whether running the capability at `sourceRef` ('<connectorType>:<fn>' or a
 *  bare fn) is a write/outbound-class action needing human approval — the same
 *  categories the executor gates on, read at MINT time so the handle can carry
 *  the class marker. A function neither the cache nor the registry knows (or a
 *  lookup error) reports true: an unknown class is treated as approval-needed,
 *  matching the executor's fail-closed refusal. `apify:run_actor` is a read. */
export async function capabilityRequiresApproval(sourceRef: string): Promise<boolean> {
  const toolName = sourceRef.includes(':') ? sourceRef.slice(sourceRef.indexOf(':') + 1) : sourceRef;
  // sourceRef is '<connectorType>:<fn>'; the classification is keyed by connector type,
  // so pass it rather than matching the bare tool name across every connector.
  const connectorType = sourceRef.includes(':') ? sourceRef.slice(0, sourceRef.indexOf(':')) : undefined;
  try {
    const gate = await gateCategoriesFor(connectorType, toolName);
    if (!gate) return true;
    return gate.categories.some((c: string) => BLOCKED_CATEGORIES.has(c));
  } catch {
    return true;
  }
}

/** The registry's own categories that describe a read and nothing else. A
 *  'sensitive' read is still a read; 'internalCollaboration' is a post into
 *  the workspace's chat — unheld by the approval gate, and a write. */
const REGISTRY_READ_ONLY_CATEGORIES = new Set(['read', 'sensitive']);

/** Whether a capability is AFFIRMATIVELY a read — the standard for running it
 *  automatically, without the model choosing it, as another candidate's
 *  fallback.
 *
 *  `capabilityRequiresApproval() === false` is not enough: the approval gate
 *  holds what leaves the workspace or cannot be undone, and lets a registry
 *  'write' (mapped to 'dataChanges') run unheld because the person asked for
 *  it. An automatic fallback has no person asking, so it needs the positive
 *  answer: the reviewed registry says the function reads and says nothing
 *  else, or — for `apify:run_actor` — the reviewed, manually held
 *  classification row (migration 454) says the actor-run class is a read.
 *  Unknown, write, outbound, destructive and mixed all answer false. Read at
 *  mint, and again before each automatic execution, so a classification that
 *  drifted in between cannot turn a fallback into a mutation. */
export async function capabilityIsAffirmativeRead(sourceRef: string): Promise<boolean> {
  if (!sourceRef.includes(':')) return false;
  const connectorType = sourceRef.slice(0, sourceRef.indexOf(':'));
  const toolName = sourceRef.slice(sourceRef.indexOf(':') + 1);
  if (!connectorType || !toolName) return false;
  try {
    if (connectorType === 'apify' && toolName === 'run_actor') {
      const cached = await toolClassifier.getCachedClassification(toolName, connectorType);
      return !!cached && cached.isManualOverride === true && cached.categories.length === 0;
    }
    const fn = (await fetchConnectorFunctions(connectorType)).find((f) => f.name === toolName);
    if (!fn || !Array.isArray(fn.categories) || fn.categories.length === 0) return false;
    return fn.categories.includes('read') && fn.categories.every((c) => REGISTRY_READ_ONLY_CATEGORIES.has(c));
  } catch {
    return false;
  }
}

/** The tenant's own connected connector id for this vendor type, or null.
 *  A hit means run on the tenant's credential (Risk B); the hidden platform
 *  vendors are never user-connectable, so they never hit and always fall to
 *  the platform path. A lookup failure degrades to platform rather than
 *  blocking. The choice itself — first positively connected row of the type
 *  — is the shared rule in credential-scope.ts, the same one search resolves
 *  a caller's credentials with, so the two cannot judge different keys.
 *  Re-resolved on every call rather than carried on the handle: a handle
 *  lives thirty minutes and a connection can change underneath it. */
async function resolveConnectedConnectorId(
  tenantId: string,
  accountId: string,
  connectorType: string,
): Promise<string | null> {
  if (!accountId) return null;
  try {
    const connectors = await listConnectorsForTenant(tenantId, accountId);
    return selectConnectedConnector(connectors, connectorType)?.id ?? null;
  } catch {
    return null;
  }
}

/** Park the credential a call just failed on, for the window its failure
 *  class gets. Keyed by the connector id ACTUALLY dispatched — `connector:<id>`
 *  for a workspace's own connector, `internal:<type>` for the platform key —
 *  never by the tenant or the discovery route, so two connectors of one type
 *  in one workspace are two parks and a platform failure parks the platform
 *  key for everyone. Fail-soft inside. */
async function parkFailedCredential(args: {
  connectorType: string;
  connectorId: string | null;
  tenantId: string;
  reason: CooldownReason;
}): Promise<void> {
  await parkCredential({
    credentialRef: credentialRefFor(args.connectorType, args.connectorId),
    connectorType: args.connectorType,
    tenantId: args.connectorId ? args.tenantId : null,
    reason: args.reason,
    durationMs: CREDENTIAL_COOLDOWN_MS[args.reason],
  });
}

/**
 * Which surface spent it, in the spelling the cost ledger already uses.
 *
 * A capability run has no agent id on this path — the Liftoff assistant and the
 * Chief AI Officer have no `internal_agents` row at all, and the runtime does
 * not send one on `/run`. Without this the row would carry neither, so the
 * Cost Breakdown would have nowhere to put it and would render vendor spend
 * under "Unattributed", belonging to nobody.
 *
 * It is never unknowable. `caller` is on the input and decides whether a
 * write-class tool may execute, so the identity was right there being used for
 * something more important. `purpose` is the SAME dimension the web-tool spend
 * subscriber writes for browser sessions ('liftoff' / 'team_plan'), which is
 * why those already appear by name and these did not: one publisher set it and
 * the other did not.
 *
 * 'agent' returns undefined deliberately — a team's capability run is the one
 * case where the right answer is an agent id, not a surface, and naming it
 * 'agent' would attribute a team's spend to a fictional assistant. It stays
 * unattributed until the runtime sends the id (see `agentId` below).
 */
export function surfaceForCaller(caller: 'assistant' | 'caio' | 'agent' | undefined): string | undefined {
  switch (caller) {
    case 'caio':      return 'team_plan';
    case 'assistant': return 'liftoff';
    default:          return undefined;
  }
}

/** Book a capability call's spend to the workspace, following the funding
 *  source — the ONE place a platform-backend capability run reaches the money
 *  authority (ingestEventWithBuckets); the runtime usage feed never sees these
 *  calls (INV-PB-013). x402_wallet / tenant_key set their bucket flags;
 *  everything else (a platform-held key) books the ordinary customer path.
 *  costUsd 0/undefined is not passed here (books nothing). Never throws:
 *  billing must not fail a tool. */
async function bookVendorSpend(args: {
  tenantId: string;
  connectorType: string;
  toolName: string;
  idempotencyKey: string;
  costUsd: number;
  funding: string | undefined;
  startedAt: number;
  /** The agent that ran this, when one did and the caller sent its id. */
  agentId?: string;
  /** The platform assistant that ran it, when there is no agent. */
  purpose?: string;
}): Promise<void> {
  try {
    const attributionAccountId = await resolveAccountIdForTenant(args.tenantId);
    if (!attributionAccountId) {
      log.warn(
        { tenantId: args.tenantId, connectorType: args.connectorType, toolName: args.toolName },
        'capability call: no account for tenant, spend not booked',
      );
      return;
    }
    await ingestEventWithBuckets(attributionAccountId, args.idempotencyKey, args.costUsd, {
      tenantId: args.tenantId,
      eventType: 'connector_call',
      source: 'tenant_runtime',
      connector: args.connectorType,
      actionType: args.toolName,
      // Who spent it. Either an agent's id or the assistant's surface, never
      // both and often neither — a team run whose caller sent no id still has
      // to book, because billing must not depend on attribution being known.
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.purpose ? { purpose: args.purpose } : {}),
      occurredAt: new Date(args.startedAt),
      usageQuantity: 1,
      usageUnit: 'call',
      ...(args.funding === 'x402_wallet' ? { x402Funded: true } : {}),
      ...(args.funding === 'tenant_key' ? { byokFunded: true } : {}),
    });
  } catch (err) {
    log.error(
      { err, tenantId: args.tenantId, connectorType: args.connectorType, toolName: args.toolName, funding: args.funding },
      'capability cost attribution failed (billing only; tool result unaffected)',
    );
  }
}

/** The decision a blocked (write/outbound-class) classification produces, given
 *  who is calling and whether a human approved. Write-class executes ONLY for
 *  an agent run a human has approved; every other caller refuses. This is the
 *  authority — it re-derives the class from the live classification here, so a
 *  handle whose plaintext marker was stripped or flipped can never buy an
 *  unapproved execution, only a refusal. */
export function blockedClassOutcome(
  blockedCats: string[],
  caller: VendorToolRunInput['caller'],
  approved: boolean | undefined,
): VendorToolRunResult | null {
  if (blockedCats.length === 0) return null;
  if (caller === 'agent' && approved === true) return null; // approved agent run: execute
  return {
    success: false,
    requiresApproval: true,
    reason: `this capability performs a ${blockedCats.join(', ')} action and needs human approval before it runs`,
  };
}

/** Run a vendor tool, logging every refusal with the facts it is about.
 *
 *  A refusal's reason can name the vendor, so the model-facing surface renders
 *  it as a neutral line — but the reason itself must be written somewhere, or a
 *  send a person approved can fail with no record of why. This is the one
 *  exit every refusal passes through. */
export async function executeVendorTool(input: VendorToolRunInput): Promise<VendorToolRunResult> {
  const outcome = await executeVendorToolInner(input);
  if (!outcome.success) {
    log.info(
      {
        event: 'capability_run_refused',
        tenantId: input.tenantId,
        connectorType: input.connectorType,
        toolName: input.toolName,
        caller: input.caller ?? 'assistant',
        approved: input.approved === true,
        hasAccount: Boolean(input.accountId),
        requiresApproval: 'requiresApproval' in outcome && outcome.requiresApproval === true,
        argumentsRejected: 'argumentsRejected' in outcome && outcome.argumentsRejected === true,
        skipped: 'skipped' in outcome ? outcome.skipped : null,
        accountFailure: 'accountFailure' in outcome ? outcome.accountFailure ?? null : null,
        autoFailoverSafe: 'autoFailoverSafe' in outcome ? outcome.autoFailoverSafe !== false : true,
        reason: outcome.reason,
      },
      'capability run refused',
    );
  }
  return outcome;
}

async function executeVendorToolInner(input: VendorToolRunInput): Promise<VendorToolRunResult> {
  const started = Date.now();
  const { tenantId, accountId, connectorType, toolName, args, presetArgs } = input;
  const caller = input.caller ?? 'assistant';
  const approved = input.approved === true;

  const catalog = await getCatalog().catch(() => null);
  const def = catalog?.connectors.find((c) => c.type === connectorType);
  if (!def) return { success: false, reason: `unknown connector type: ${connectorType}` };
  if (def.status !== 'internal' && def.status !== 'available') {
    return { success: false, reason: `connector ${connectorType} is not enabled` };
  }
  // The operator's switch (vendor-gate.ts). Checked at execution as well as at
  // the offer step: a handle minted before the switch was set must not run.
  if (await platformVendorSwitchedOff(connectorType)) {
    return { success: false, reason: `connector ${connectorType} is switched off by the operator` };
  }

  // Platform-funded Apify actor run — the one "call-actor" capability class. A
  // native, platform-backend-LOCAL path, because the platform Apify token lives
  // HERE (the probe-runner uses it), not in connector-service. It runs a public
  // Store actor on the platform account and returns its dataset items. It skips
  // the connector-service RPC and the connector-function registry gate (an actor
  // is not a registry function), but keeps the SAME classification gate, billing
  // and usage-evidence as every other capability. Funding is always the platform
  // key, so it books the ordinary customer OU path.
  if (connectorType === 'apify' && toolName === 'run_actor') {
    const actorId =
      presetArgs && typeof presetArgs.actorId === 'string' ? presetArgs.actorId : '';
    if (!actorId) {
      return { success: false, reason: 'this capability is missing its source reference; run capability_search again' };
    }
    const cached = await toolClassifier.getCachedClassification(toolName, connectorType).catch(() => null);
    if (!cached) {
      return { success: false, reason: `tool ${toolName} has no classification yet; refusing to execute` };
    }
    const blockedCats = cached.categories.filter((c: string) => BLOCKED_CATEGORIES.has(c));
    const apifyBlocked = blockedClassOutcome(blockedCats, caller, approved);
    if (apifyBlocked) return apifyBlocked;

    // Whose money, in order. FIRST the workspace's own Apify account when it
    // has connected one: the run goes to connector-service on that connector
    // (its native executor, booked tenant_key, so the vendor part costs the
    // workspace no Operating Units). An ACCOUNT failure there (the key
    // refused, the account cannot pay) parks that connector and falls to the
    // platform's rungs below; any other failure is the run's own and stands.
    const connectedApify = await resolveConnectedConnectorId(tenantId, accountId, connectorType);
    if (connectedApify) {
      const tenantRef = credentialRefFor(connectorType, connectedApify);
      if (!isCooling(tenantRef)) {
        const own = await runApifyOnWorkspaceAccount({
          tenantId, connectorId: connectedApify, actorId, args,
          idempotencyKey: input.idempotencyKey, started,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(surfaceForCaller(input.caller) ? { purpose: surfaceForCaller(input.caller) } : {}),
        });
        if (own.next === 'done') return own.outcome;
        if (own.park) await parkFailedCredential({ connectorType, connectorId: connectedApify, tenantId, reason: own.park });
        log.warn(
          { event: 'apify_workspace_account_unavailable', tenantId, connectorId: connectedApify, reason: own.park ?? 'connector_service_unreachable' },
          'the workspace\'s own Apify account could not take the run; the platform\'s rungs take it',
        );
      }
    }
    // Then the platform: runApifyActor picks the x402 prepaid token or the
    // platform account per actor — the platform's money either way, so the
    // money authority is asked first, as for every platform-funded call.
    const apifyGuard = await checkExecutionAllowed(tenantId);
    if (!apifyGuard.allowed) {
      return { success: false, skipped: 'unfunded', reason: apifyGuard.reason ?? 'the workspace cannot be admitted to spend' };
    }
    // Its cooldown is read under `internal:apify`. Checked here, after the
    // gate and before the vendor call, so a parked credential costs nothing.
    const apifyCredentialRef = credentialRefFor(connectorType, null);
    if (isCooling(apifyCredentialRef)) {
      return { success: false, skipped: 'cooling', reason: `credential ${apifyCredentialRef} is cooling after an account-level failure` };
    }
    const run = await runApifyActor(actorId, args);
    const apifyLatencyMs = Date.now() - started;
    // The run id is the booking's identity: one run, one charge, and the
    // ledger row is then joinable back to the vendor's own record of the run.
    // A caller-supplied key (an approved agent run resuming) still wins.
    const vendorRunRef = run.runId ? apifyRunRef(run.runId) : undefined;
    const apifyIdempotencyKey = input.idempotencyKey ?? vendorRunRef ?? randomUUID();
    // Booked whether or not the run answered: a FAILED actor still charged
    // for its compute, and an empty dataset still charged its start fee. The
    // vendor's positive figure is the charge, under this attempt's own key.
    if (run.costUsd !== undefined && run.costUsd > 0) {
      await bookVendorSpend({
        tenantId,
        connectorType,
        toolName,
        idempotencyKey: apifyIdempotencyKey,
        costUsd: run.costUsd,
        funding: run.fundingSource ?? 'platform_key',
        startedAt: started,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(surfaceForCaller(input.caller) ? { purpose: surfaceForCaller(input.caller) } : {}),
      });
    }
    // Keyed the way the store search keys the candidate — `apify_store` plus
    // the actor id — so the ranking's evidence read finds it. Under the
    // executor's own name (`connector_registry` / `apify:run_actor`) every
    // actor's runs pooled into one row nothing looked up, and no actor was
    // ever promoted or demoted by its own record. The cost reconciler reads
    // both keys (src/scripts/apify-cost-trueup.ts).
    await recordUsageEvidence({
      source: 'apify_store',
      sourceRef: actorId,
      tenantId,
      success: run.success,
      latencyMs: apifyLatencyMs,
      costUsd: run.costUsd,
      outputNote: `${run.success ? 'ok' : 'vendor failure'}${vendorRunRef ? ` ${vendorRunRef}` : ''}${itemsNote(run.success ? recordCountOf(run.items) : null)}`,
    });
    log.info(
      {
        metric: 'vendor_tool_cost',
        tenantId,
        connectorType,
        toolName,
        success: run.success,
        latencyMs: apifyLatencyMs,
        costUsd: run.costUsd ?? null,
        runId: run.runId ?? null,
        items: run.success ? recordCountOf(run.items) : null,
      },
      'vendor tool executed',
    );
    if (!run.success) {
      const reason = run.error || 'the source could not be run';
      if (run.argumentsRejected) {
        return { success: false, argumentsRejected: true, reason: run.error || 'the source rejected the input' };
      }
      if (run.accountFailure) {
        await parkFailedCredential({ connectorType, connectorId: null, tenantId, reason: run.accountFailure });
        return { success: false, reason, accountFailure: run.accountFailure };
      }
      if (run.autoFailoverSafe === false) {
        return { success: false, reason, autoFailoverSafe: false };
      }
      return { success: false, reason };
    }
    const structured = run.items ?? [];
    // A real run that returned results is what teaches the platform what this
    // automation's output looks like: field names and types only, never the
    // customer's values. Fire-and-forget; the tool result never waits on it.
    if (structured.length > 0 && run.runId) {
      fireAndForget(
        elevateBlueprintFromRun({
          source: 'apify_store',
          sourceRef: actorId,
          items: structured,
          runId: run.runId,
        }),
        'capability blueprint elevation',
      );
    }
    return {
      success: true,
      content: renderCapabilityResult(structured),
      structuredContent: structured,
      ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
      ...(vendorRunRef ? { vendorRunRef } : {}),
    };
  }
  // User-key-first: if the tenant connected their OWN connector of this type,
  // run on their credential via the ordinary connector-instance path — which
  // is also the only way the BYO-only vendors execute at all. Absent a tenant
  // connector, fall back to the platform path, which only some vendors have.
  const connectedConnectorId = await resolveConnectedConnectorId(tenantId, accountId, connectorType);
  if (!connectedConnectorId) {
    if (BYO_ONLY_VENDORS.has(connectorType)) {
      return {
        success: false,
        reason: `${connectorType} runs only on a workspace's own key, which is not connected`,
      };
    }
    if (!PLATFORM_EXECUTABLE_VENDORS.has(connectorType)) {
      return { success: false, reason: `${connectorType} has no platform execution path yet` };
    }
  }
  const connectorId = connectedConnectorId ?? `internal:${connectorType}`;
  // A platform-funded call is paid before its cost is booked, so the money
  // authority is asked FIRST — the same guard, with the same prepaid floor,
  // that admits a run. The runtime's gates read a snapshot of it and refuse
  // seconds after a crossing; this read has no lag at all, so a workspace
  // that just ran out never has the vendor paid on its behalf for one more
  // call. A workspace's own connector is its own money and is not asked.
  if (!connectedConnectorId) {
    const guard = await checkExecutionAllowed(tenantId);
    if (!guard.allowed) {
      return { success: false, skipped: 'unfunded', reason: guard.reason ?? 'the workspace cannot be admitted to spend' };
    }
  }
  // The cooldown is read under the SAME resolved connector the call would
  // dispatch on — the decision above — so what execution skips is exactly
  // what a park on this credential named. Before the registry and the gate
  // as well as before transport: a parked credential costs nothing here.
  const credentialRef = credentialRefFor(connectorType, connectedConnectorId);
  if (isCooling(credentialRef)) {
    return { success: false, skipped: 'cooling', reason: `credential ${credentialRef} is cooling after an account-level failure` };
  }

  // The tool must be a NAMED entry in our registry for this connector — the
  // registry is the curated, reviewed surface, and a name outside it does not
  // execute no matter what any live server advertises.
  const registry = await fetchRegistry().catch(() => null);
  const functionNames = registry?.get(connectorType)?.functionNames ?? [];
  if (!functionNames.includes(toolName)) {
    return { success: false, reason: `tool ${toolName} is not in the ${connectorType} registry` };
  }

  // The gate, fail-closed: a function whose class nobody can state does not
  // run. The classification cache answers when it has a row; otherwise the
  // registry's own categories for the function do (see gateCategoriesFor).
  const gate = await gateCategoriesFor(connectorType, toolName).catch(() => null);
  if (!gate) {
    return { success: false, reason: `tool ${toolName} has no classification yet; refusing to execute` };
  }
  const blocked = gate.categories.filter((c: string) => BLOCKED_CATEGORIES.has(c));
  const blockedOutcome = blockedClassOutcome(blocked, caller, approved);
  if (blockedOutcome) return blockedOutcome;

  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  try {
    const client = getConnectorServiceClient();
    const response = await client.execute(
      create(ExecuteRequestSchema, {
        tenantContext: { tenantId },
        connectorId,
        functionName: toolName,
        // The tool-call args arrive as parsed JSON from the model, so they are
        // structurally a JsonObject; the Record<string, unknown> type is just
        // wider than the parse can produce.
        input: args as JsonObject,
        idempotencyKey,
        traceId: randomUUID(),
      }),
      // connector-service's Execute idempotency is scoped by the tenant
      // header, and engages only when it is present. It is sent only for a
      // caller-supplied key — one that names an act a ledger already claims —
      // so a repeat of that act replays at the boundary. A key minted here is
      // a per-call id, and a per-call id has nothing to replay.
      input.idempotencyKey ? { headers: { 'x-tenant-id': tenantId } } : undefined,
    );
    const latencyMs = Date.now() - started;
    const costUsd = response.costUsd > 0 ? response.costUsd : undefined;

    // A capability run executes the vendor call HERE, inside platform-backend
    // (the assistant, the internal run route an agent reaches through
    // run_capability, and the CAIO), so it never reaches the tenant-runtime
    // usage-ledger feed the poller ingests. This is the ONLY place that can
    // book the spend; left unbooked, a paid capability call consumes no
    // Operating Units (INV-PB-013). connector-service's funding_source is the
    // authority on which key actually paid, and the charge follows it:
    //   - 'x402_wallet'  → platform wallet paid the vendor per call; charge the
    //                      workspace OUs, bucket 'x402_wallet_funded', meter.
    //   - 'platform_key' → a platform-held vendor key/balance paid (tikhub,
    //                      strale, …); the workspace used a paid capability, so
    //                      charge it OUs on the ordinary customer path.
    //   - 'tenant_key'   → the workspace's OWN connected key paid the vendor
    //                      directly; zero-rate (byok_customer_funded) so we do
    //                      not bill twice, but still record the usage row
    //                      (INV-PB-014).
    // The account is the workspace's own (resolveAccountIdForTenant), so an
    // assistant call with no agent identity still bills the workspace, and
    // source='tenant_runtime' classifies the call as customer workload with or
    // without an agentId. costUsd===0 (gloria free, nasdaq) books nothing.
    // A booking failure is logged and swallowed — billing never fails the tool.
    // Booked on failure too: a vendor that charged for a call that then
    // failed or answered nothing still charged, and the charge is this
    // attempt's, under this attempt's own key.
    if (costUsd !== undefined) {
      await bookVendorSpend({
        tenantId,
        connectorType,
        toolName,
        idempotencyKey,
        costUsd,
        funding: response.fundingSource,
        startedAt: started,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(surfaceForCaller(input.caller) ? { purpose: surfaceForCaller(input.caller) } : {}),
      });
    }

    await recordUsageEvidence({
      source: 'connector_registry',
      sourceRef: `${connectorType}:${toolName}`,
      tenantId,
      success: response.success,
      latencyMs,
      costUsd,
      outputNote: `${response.success ? 'ok' : 'vendor failure'}${itemsNote(response.success ? recordCountOf(response.result) : null)}`,
    });
    // Per-tenant cost attribution for platform-funded data calls; the
    // executor's own costUsd (the vendor's account of the charge, for
    // vendors that report one) rides through the RPC.
    log.info(
      {
        metric: 'vendor_tool_cost',
        tenantId,
        connectorType,
        toolName,
        success: response.success,
        latencyMs,
        costUsd: costUsd ?? null,
        items: response.success ? recordCountOf(response.result) : null,
      },
      'vendor tool executed',
    );

    if (!response.success) {
      const reason = response.error || 'the tool reported an error';
      // Arguments first: a rejected argument is the caller's to fix and is
      // never an account failure, whatever status its message quotes.
      if (argumentsRejectedOnWire(response.errorCode ?? '', reason)) {
        return { success: false, argumentsRejected: true, reason };
      }
      const accountFailure = accountFailureOnWire(response.errorCode ?? '', reason);
      if (accountFailure) {
        await parkFailedCredential({ connectorType, connectorId: connectedConnectorId, tenantId, reason: accountFailure });
        return { success: false, reason, accountFailure };
      }
      return { success: false, reason };
    }
    const structured = response.result;
    return {
      success: true,
      content: renderCapabilityResult(structured ?? {}),
      structuredContent: structured,
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  } catch (error) {
    await recordUsageEvidence({
      source: 'connector_registry',
      sourceRef: `${connectorType}:${toolName}`,
      tenantId,
      success: false,
      latencyMs: Date.now() - started,
      outputNote: 'transport failure',
    });
    log.warn({ error, connectorType, toolName }, 'vendor tool execution failed');
    return { success: false, reason: 'the vendor call failed; see logs' };
  }
}
