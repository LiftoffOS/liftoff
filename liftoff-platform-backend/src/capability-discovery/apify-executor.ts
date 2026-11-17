// Platform-funded Apify actor execution — the one "call-actor" capability class.
//
// A native, platform-backend-LOCAL execution path for running a public Apify
// Store actor on the platform's own Apify account and returning its dataset
// items. It lives HERE, not in connector-service, because the platform Apify
// token (APIFY_PLATFORM_TOKEN) is mounted in platform-backend, and routing the
// run through connector-service would mean mounting the same secret in a
// second service for no gain.
//
// The single guarded executor (vendor-execution.executeVendorTool) still owns
// classification, billing and enforcement; this module only performs the vendor
// call and reports the run id and the cost of THAT run. Inert without
// APIFY_PLATFORM_TOKEN: no token, no run, and nothing pretends otherwise.
//
// The platform account is one account for every environment and every tenant,
// so runs of the same actor overlap as a matter of course. Everything here is
// keyed by the run id the start call returns; nothing reads "the actor's most
// recent run", which once booked a customer's run at the price of a different
// run that happened to start seconds later.
//
// Two bearers can run an actor, and the choice is made per run
// (resolveApifyCredential): a PREPAID TOKEN bought through Locus
// (billing/apify-prepaid-token-service.ts), which Apify honours only for
// pay-per-event actors, so it is chosen when a live one exists and the
// actor's current pricing is pay-per-event; otherwise the platform account
// key, which is also the only bearer for the actors prepaid tokens do not
// cover. When no prepaid token is live the RUN buys one — waiting for the
// next scheduled tick is what sent every Apify run to the platform account
// on the night the account's monthly limit ran out. The run result says
// which paid, so the booking carries the right funding.
//
// A REFUSED PREPAID START IS NOT EVIDENCE OF A SPENT TOKEN. Apify answers 403
// both for an exhausted token and for an actor outside a token's eligibility,
// so the refusal is followed by a balance read, and only a token the vendor
// reports spent, overdrawn or refused is retired and replaced (once). A
// healthy token refused for this actor is kept, nothing is bought, and the
// run falls through to the platform account.
//
// THE PLATFORM ACCOUNT IS PARKED ON ITS OWN, under a credential ref of its
// own, when Apify answers its monthly hard limit: `internal:apify` is checked
// before every platform Apify rung, so parking THAT would have stopped the
// healthy prepaid tokens too.

import { log } from '../infrastructure/logging';
import { summarizeArgs, type ArgSummary } from './args-hint';
import { isCooling, parkCredential, platformVendorSwitchedOffSync } from './vendor-gate';
import {
  apifyPrepaidMinBalanceUsd,
  ensureApifyPrepaidToken,
  getLiveApifyPrepaidToken,
  refreshApifyPrepaidBalance,
  type ApifyPrepaidToken,
} from '../billing/apify-prepaid-token-service';

const APIFY_BASE = 'https://api.apify.com/v2';
const RUN_TIMEOUT_SECONDS = 90;
const RUN_MEMORY_MB = 1024;
/** Items read back from the run's dataset, AND the most a pay-per-result
 *  actor may charge for (`maxItems` on the start call): an actor that scraped
 *  a thousand rows for a call that reads a hundred was charging for nine
 *  hundred nobody saw. */
const MAX_ITEMS = 100;
/** The most one run may charge, in USD, whatever the actor's pricing
 *  (`maxTotalChargeUsd` on the start call; Apify stops the run at the cap).
 *  The platform account has no auto-reload and a fixed credit, so a single
 *  runaway actor must not be able to drain it. Overridable per environment;
 *  the default covers every run booked on the account to date by a wide
 *  margin (largest observed: $0.76). */
const RUN_MAX_TOTAL_CHARGE_USD = (() => {
  const raw = Number(process.env.APIFY_MAX_RUN_CHARGE_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
})();

/** The platform ACCOUNT's own cooldown key, distinct from `internal:apify`.
 *
 *  `internal:apify` is read before every platform Apify rung, prepaid tokens
 *  included, so parking it when the ACCOUNT hit its monthly limit would have
 *  stopped the Locus-funded token that still had its whole dollar on it. The
 *  cooldown table takes any key, so this needs no migration. */
const PLATFORM_ACCOUNT_CREDENTIAL_REF = 'internal:apify:platform-account';

/** Apify's own answer for an account that has spent its monthly hard limit:
 *  403 `{"error":{"type":"platform-feature-disabled","message":"Monthly usage
 *  hard limit exceeded"}}`. Not a dead key (401) and not a refusal to pay for
 *  one call (402) — the account can pay for nothing at all until its usage
 *  cycle rolls over, which is why it is the one 403 that parks. */
const PLATFORM_LIMIT_ERROR_TYPE = 'platform-feature-disabled';

/** How long the platform account is parked when its usage cycle cannot be
 *  read. Short on purpose: guessing low costs one refused call an hour,
 *  guessing high leaves a healthy account unusable. */
const PLATFORM_LIMIT_PARK_FALLBACK_MS = 60 * 60 * 1000;
/** No park outlasts a usage cycle, whatever the vendor reports. */
const PLATFORM_LIMIT_PARK_MAX_MS = 31 * 24 * 60 * 60 * 1000;

/** How long the run path waits before trying to buy another prepaid token
 *  after an attempt that produced none. The per-day cap counts purchases
 *  MADE, so it bounds nothing when every attempt is refused — and an attempt
 *  is a call to connector-service with a ninety-second deadline, on the path
 *  of a run somebody is waiting for. */
const PURCHASE_ATTEMPT_BACKOFF_MS = 5 * 60 * 1000;
let lastFruitlessPurchaseAt = 0;

/** Test-only: the backoff above is process state, and a test that buys twice
 *  would otherwise be answering the first test's clock. */
export function _resetApifyPurchaseBackoff(): void {
  lastFruitlessPurchaseAt = 0;
}

export type ApifyFundingSource = 'x402_wallet' | 'platform_key';

export interface ApifyActorRunResult {
  success: boolean;
  items?: unknown[];
  /** Which bearer paid for the run: the x402 wallet's prepaid token, or the
   *  platform account. Set whenever a run was started. */
  fundingSource?: ApifyFundingSource;
  /** The run's cost as the vendor reported it, when a run was started and
   *  its record could be read — on a FAILED run as much as a successful one,
   *  because the vendor charges for the compute either way and the charge has
   *  to be booked under that attempt's own key. */
  costUsd?: number;
  /** The Apify run this result came from. Set whenever a run was started,
   *  success or not: it is the key every booking and trace of the run uses. */
  runId?: string;
  error?: string;
  /** The source rejected the input itself — a wrong type, a missing field —
   *  and `error` carries its own account of what is wrong. A caller passes
   *  that on to whoever wrote the arguments rather than trying elsewhere. */
  argumentsRejected?: boolean;
  /** The platform ACCOUNT failed, not this run: the start call answered 401
   *  (the token is not accepted) or 402 (the account cannot pay). Definite and
   *  pre-start — no run was created — so the caller may park the credential
   *  and go on to another source. Exclusive with argumentsRejected. */
  accountFailure?: 'auth' | 'payment';
  /** False when a paid run MAY have started, or did start, and this call could
   *  not see it through: the start call timed out, answered 5xx, or answered
   *  without a run id (the actor may be running with no id to find it by), or
   *  a run this call started then failed to poll, failed as an actor, or would
   *  not give up its dataset (cost was incurred, the answer is unknown). A
   *  caller must not start another paid actor or vendor from such a call; the
   *  known run id is logged for the reconciler. Absent means the failure was
   *  definite and pre-start: a 4xx refusal, the account's 401 or 402. */
  autoFailoverSafe?: false;
}

/** The source's own error envelope: `{ error: { type, message } }`. */
function readSourceError(detail: string): { type: string; message: string } | null {
  try {
    const parsed = JSON.parse(detail) as { error?: { type?: unknown; message?: unknown } };
    const type = parsed?.error?.type;
    const message = parsed?.error?.message;
    if (typeof type === 'string' && typeof message === 'string') return { type, message };
  } catch {
    // Not the envelope; the caller falls back to the status line.
  }
  return null;
}

/** The API path form of an actor id: 'username/actor' -> 'username~actor'. */
function toApiActorId(actorId: string): string {
  return actorId.trim().replace('/', '~');
}

/** Whether the platform Apify account can be used: configured, AND not
 *  switched off by the operator (vendor-gate.ts). Gates whether an Apify
 *  Store candidate is offered as a runnable capability at all — by capability
 *  search and by the distiller's prior art alike, so the two cannot disagree
 *  about what is runnable. The switch is read from the gate's cache; every
 *  path that reaches this has refreshed it in the same request. */
export function apifyPlatformConfigured(): boolean {
  const configured = Boolean(process.env.APIFY_PLATFORM_TOKEN && process.env.APIFY_PLATFORM_TOKEN.trim());
  return configured && !platformVendorSwitchedOffSync('apify');
}

/** Apify's own run record, the subset this module reads. */
interface ApifyRun {
  id: string;
  status: string;
  statusMessage?: string;
  usageTotalUsd?: number;
  /** Per-event pricing, when the actor charges per result rather than for
   *  compute alone; `pricingModel` is what this module keys on. */
  pricingInfo?: { pricingModel?: string };
  /** The vendor's own count of charged events. Empty until the accounting
   *  catches up with the run, which is AFTER the status turns terminal. */
  chargedEventCounts?: Record<string, number>;
}

/** Pricing models under which the per-result charges of a run land after its
 *  status turns terminal. On a PAY_PER_EVENT actor, at SUCCEEDED the run can
 *  carry only the start fee and zero item events; the event counts appear
 *  seconds later and the USD figure later still. */
const PER_RESULT_PRICING_MODELS = new Set(['PAY_PER_EVENT', 'PRICE_PER_DATASET_ITEM']);
/** How long the settlement read waits for the per-result charges, in total
 *  and between polls. The bound is the expected lag plus a margin; a run that
 *  settles later than this is booked at the figure it carried and picked up by
 *  the reconciler (src/scripts/apify-cost-trueup.ts), which is the net. */
const SETTLEMENT_WAIT_MS = 15_000;
const SETTLEMENT_POLL_MS = 2_000;

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
/** The most Apify will hold one poll open for. */
const MAX_WAIT_FOR_FINISH_SECONDS = 60;

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Run one actor on the platform account and return its dataset items plus
 *  the run's real USD cost. Never throws — a failure is a typed result the
 *  caller turns into a { success: false } refusal.
 *
 *  The executor OWNS the run id: it starts the run itself, waits on that id,
 *  reads that run's items and reads that run's cost. Nothing here is "the
 *  actor's most recent run", because the platform account is shared by every
 *  environment and every tenant, and two runs of one actor overlap routinely
 *  (two workspaces asking at once; a second run of the same actor started
 *  seconds later). A cost read that is not keyed by run id charges one
 *  customer for another's run — or for nothing. */
export interface ApifyCredential {
  token: string;
  funding: ApifyFundingSource;
  /** WHICH BEARER this is, which is what every decision on the run path is
   *  about. `funding` cannot answer it: a Locus-funded prepaid token books as
   *  platform money exactly like the account key, and keying the prepaid
   *  retry on `funding === 'x402_wallet'` is why a refused Locus-funded token
   *  got no fallback at all. */
  bearer: 'prepaid' | 'account';
  /** The prepaid purchase the token belongs to, for the balance re-read. */
  purchaseId?: string;
  /** What the vendor last reported this prepaid token has left. The run is
   *  capped at it, because Apify does NOT stop a run at the token's balance. */
  balanceUsd?: number;
}

/** The pricing models the prepaid token is honoured for. Apify's own rule:
 *  pay-per-event only; rental and pay-per-usage actors are not sold over
 *  x402, and neither is the older per-dataset-item model. */
const PREPAID_ELIGIBLE_PRICING_MODELS = new Set(['PAY_PER_EVENT']);
const PRICING_MODEL_TTL_MS = 60 * 60 * 1000;
const pricingModelCache = new Map<string, { model: string | null; at: number }>();

/** The actor's CURRENT pricing model, from its record: the last pricing
 *  entry that has started. Null when it cannot be read, which routes the run
 *  to the account key (the conservative rung). Cached an hour per actor. */
export async function fetchApifyActorPricingModel(actorId: string, token: string): Promise<string | null> {
  const id = toApiActorId(actorId);
  const cached = pricingModelCache.get(id);
  if (cached && Date.now() - cached.at < PRICING_MODEL_TTL_MS) return cached.model;
  let model: string | null = null;
  try {
    const resp = await fetch(`${APIFY_BASE}/acts/${encodeURIComponent(id)}`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(8_000),
    });
    if (resp.ok) {
      const body = (await resp.json().catch(() => null)) as { data?: { pricingInfos?: Array<{ pricingModel?: string; startedAt?: string }> } } | null;
      const infos = (body?.data?.pricingInfos ?? []).filter((p) => !p.startedAt || Date.parse(p.startedAt) <= Date.now());
      model = infos.length ? (infos[infos.length - 1].pricingModel ?? null) : null;
    }
  } catch (error) {
    log.debug({ error, actorId }, 'apify actor pricing read failed; account key will run it');
  }
  pricingModelCache.set(id, { model, at: Date.now() });
  return model;
}

/** How many live tokens the run path will walk past when the one it picked
 *  turns out, on reading, to be spent. Bounded because each step is a vendor
 *  read; the float is two or three tokens at the most. */
const PREPAID_SELECTION_ATTEMPTS = 3;

/**
 * The live prepaid token a run should use, with the balance the VENDOR
 * reports right now — never a throw: a token read that failed must not be
 * the thing that stops a run.
 *
 * THE BALANCE IS READ HERE, BEFORE THE RUN, because it is what the run is
 * capped at and a stored figure is not good enough to cap anything. The row
 * said $0.122 while the vendor said -$0.2206: it is written by an hourly
 * upkeep and by a re-read that lands two minutes AFTER a run finishes, so
 * between those a row is exactly as stale as the runs made since. Capping a
 * run at a stale figure is capping it at a number nobody stands behind, and
 * Apify does not enforce the balance itself.
 *
 * A token the read finds spent, refused or now under the service floor is
 * not handed to the run: the refresh has already written the true figure and
 * retired it where it should be, so the next call sees the next token.
 */
async function readLivePrepaidToken(actorId: string): Promise<ApifyPrepaidToken | null> {
  for (let attempt = 0; attempt < PREPAID_SELECTION_ATTEMPTS; attempt++) {
    let token: ApifyPrepaidToken | null;
    try {
      token = await getLiveApifyPrepaidToken();
    } catch (error) {
      log.warn({ error: (error as Error).message, actorId }, 'apify prepaid token read failed; account key will run it');
      return null;
    }
    if (!token) return null;
    const check = await refreshApifyPrepaidBalance(token.id).catch(() => ({ balanceUsd: null, retired: false }));
    if (check.retired) {
      log.info(
        { metric: 'apify_prepaid_spent_at_selection', actorId, purchaseId: token.id, balanceUsd: check.balanceUsd },
        'the prepaid token a run would have taken is spent; it was retired before the run started',
      );
      continue;
    }
    // A balance that could not be read is not a reason to refuse the token:
    // the stored figure is what there is, and it is never HIGHER than what
    // the vendor last reported.
    const balanceUsd = check.balanceUsd ?? token.balanceUsd;
    if (balanceUsd < apifyPrepaidMinBalanceUsd()) continue;
    return { ...token, balanceUsd };
  }
  return null;
}

/** A prepaid token, as the credential a run is started on. */
function prepaidCredential(token: ApifyPrepaidToken): ApifyCredential {
  return {
    token: token.token,
    bearer: 'prepaid',
    // A token the wallet bought funds the run from the wallet; one the
    // platform's Locus credits bought is platform money like the account key.
    funding: token.fundedBy === 'locus' ? 'platform_key' : 'x402_wallet',
    purchaseId: token.id,
    balanceUsd: token.balanceUsd,
  };
}

/** The platform account key, unless the account is parked. Read HERE, at the
 *  one point the account would be selected, rather than before the whole
 *  Apify route: a parked account must not take the prepaid tokens with it. */
function platformAccountToken(): string | null {
  const token = process.env.APIFY_PLATFORM_TOKEN?.trim() || null;
  if (!token) return null;
  return isCooling(PLATFORM_ACCOUNT_CREDENTIAL_REF) ? null : token;
}

/** Buy a prepaid token from the run path, through Locus. False when none was
 *  bought, for any reason; the caller goes on to the account. */
async function buyPrepaidToken(cause: string): Promise<boolean> {
  if (Date.now() - lastFruitlessPurchaseAt < PURCHASE_ATTEMPT_BACKOFF_MS) return false;
  try {
    const outcome = await ensureApifyPrepaidToken();
    if (outcome.purchased === true) return true;
    lastFruitlessPurchaseAt = Date.now();
    log.info(
      {
        event: 'apify_prepaid_run_path_purchase',
        cause,
        skipped: outcome.skipped ?? null,
        refused: outcome.refused ?? null,
        capped: outcome.capped ?? false,
      },
      'a run needed an Apify prepaid token and none could be bought',
    );
    return false;
  } catch (error) {
    lastFruitlessPurchaseAt = Date.now();
    log.warn({ error: (error as Error).message, cause }, 'the run path could not buy an Apify prepaid token');
    return false;
  }
}

/**
 * Which bearer runs this actor. The prepaid token when a live one has the
 * service's floor on it and the actor is pay-per-event — and when none is
 * live, one is BOUGHT before the account is considered, because Apify's
 * prepaid token is the thing Locus can pay for and the account key is the
 * rung that runs out. Else the platform account; null when neither exists or
 * the account is parked.
 *
 * A TOKEN IS ONLY BOUGHT FOR AN ACTOR THAT COULD SPEND IT. Apify honours a
 * prepaid token for pay-per-event actors alone, so buying one for a rental
 * or pay-per-usage actor puts a dollar of Locus credit into an account this
 * run cannot use — and the run goes to the platform account regardless. The
 * actor's pricing is read first, on whatever bearer there is to read it
 * with, and cached per actor for an hour, so the eligibility check below
 * costs nothing twice. With NO bearer at all there is nothing to ask with
 * and nothing to fall back to, so the token is bought unasked: it is the
 * only credential that could exist.
 */
export async function resolveApifyCredential(actorId: string): Promise<ApifyCredential | null> {
  const account = platformAccountToken();
  // The actor's pricing decides whether the float is relevant at all, so it
  // is asked FIRST wherever there is a bearer to ask with. An actor the
  // token cannot run then costs the float nothing: no balance read, and
  // certainly no purchase. Cached per actor for an hour, so the eligibility
  // check below reads it again for free.
  if (account) {
    const model = await fetchApifyActorPricingModel(actorId, account);
    if (model === null || !PREPAID_ELIGIBLE_PRICING_MODELS.has(model)) {
      return { token: account, funding: 'platform_key', bearer: 'account' };
    }
  }
  // With NO account there is nothing to ask with and nothing to fall back
  // to: the token is the only credential that could exist, so the float is
  // consulted first and the pricing read on the token itself.
  let prepaid = await readLivePrepaidToken(actorId);
  if (!prepaid && await buyPrepaidToken('a run found no live prepaid token')) {
    prepaid = await readLivePrepaidToken(actorId);
  }
  if (prepaid) {
    const model = await fetchApifyActorPricingModel(actorId, prepaid.token);
    if (model && PREPAID_ELIGIBLE_PRICING_MODELS.has(model)) return prepaidCredential(prepaid);
  }
  return account ? { token: account, funding: 'platform_key', bearer: 'account' } : null;
}

/** What one run may charge. The per-run cap, or the prepaid token's remaining
 *  balance when that is less.
 *
 *  APIFY DOES NOT STOP A RUN AT THE TOKEN'S BALANCE: a token with a dollar of
 *  credit can be handed several runs and finish with a negative
 *  `remainingBalanceUsd`. The cap is the only thing that keeps a run inside
 *  what was paid for. */
function maxChargeFor(credential: ApifyCredential): number {
  return credential.bearer === 'prepaid' && typeof credential.balanceUsd === 'number'
    ? Math.min(RUN_MAX_TOTAL_CHARGE_USD, Math.max(0, credential.balanceUsd))
    : RUN_MAX_TOTAL_CHARGE_USD;
}

/** One start call. `refusedStatus` carries the vendor's status for a pre-start
 *  refusal so the caller can decide whether another bearer should try, and
 *  `refusalBody` its own words, which are the difference between "this actor
 *  is not sold to this token" and "this account has spent its month". */
async function startActorRun(
  actorId: string,
  id: string,
  input: Record<string, unknown>,
  credential: ApifyCredential,
  remainingMs: () => number,
): Promise<
  | { run: ApifyRun }
  | { failure: ApifyActorRunResult; refusedStatus?: number; refusalBody?: string; platformLimit?: true }
> {
  try {
    const startUrl =
      `${APIFY_BASE}/acts/${encodeURIComponent(id)}/runs` +
      `?timeout=${RUN_TIMEOUT_SECONDS}&memory=${RUN_MEMORY_MB}&waitForFinish=${MAX_WAIT_FOR_FINISH_SECONDS}` +
      `&maxItems=${MAX_ITEMS}&maxTotalChargeUsd=${maxChargeFor(credential)}`;
    const resp = await fetch(startUrl, {
      method: 'POST',
      headers: { ...authHeaders(credential.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(input ?? {}),
      signal: AbortSignal.timeout(Math.min(remainingMs(), (MAX_WAIT_FOR_FINISH_SECONDS + 10) * 1000)),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      const sourceError = readSourceError(detail);
      if (sourceError?.type === 'invalid-input') {
        return { failure: { success: false, error: sourceError.message.slice(0, 300), argumentsRejected: true } };
      }
      const error = `the source returned an error (${resp.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`;
      const refusalBody = detail ? detail.slice(0, 300) : undefined;
      // The account, not the run: no run was created, so the failure is
      // definite and the credential is what failed. Only the two statuses that
      // say so; a 403 names a resource or a plan feature, not a dead key, and
      // a 429 clears on its own — neither parks.
      const accountFailure = accountFailureForStatus(resp.status);
      if (accountFailure) return { failure: { success: false, error, accountFailure }, refusedStatus: resp.status, ...(refusalBody ? { refusalBody } : {}) };
      // The one 403 that is about the ACCOUNT rather than the request: it has
      // spent its monthly hard limit and can pay for nothing until its usage
      // cycle rolls over. Named by the vendor's own error type, not guessed
      // from the status.
      if (sourceError?.type === PLATFORM_LIMIT_ERROR_TYPE) {
        return { failure: { success: false, error }, refusedStatus: resp.status, ...(refusalBody ? { refusalBody } : {}), platformLimit: true };
      }
      // A 4xx is the vendor refusing the request before a run exists:
      // definite, and safe to go on from. A 5xx is not that — a gateway or a
      // failing backend can answer 5xx to a request it already forwarded, so
      // the actor may be running with no id to find it by, exactly like a
      // start call that never answered.
      if (resp.status >= 500) {
        log.warn({ metric: 'apify_run_ambiguous', actorId, cause: `start call answered ${resp.status}` }, 'apify run start answered 5xx; the actor may have started');
        return { failure: { success: false, error, autoFailoverSafe: false } };
      }
      return { failure: { success: false, error }, refusedStatus: resp.status, ...(refusalBody ? { refusalBody } : {}) };
    }
    const started = (await resp.json().catch(() => null)) as { data?: ApifyRun } | null;
    if (!started?.data?.id) {
      // The vendor accepted the request and answered with no run id: the
      // actor may be running, charging, and unfindable from here.
      log.warn(
        { metric: 'apify_run_ambiguous', actorId, cause: 'no run id in the acknowledgement' },
        'apify run start acknowledged without a run id; not safe to start another',
      );
      return { failure: { success: false, error: 'the source did not acknowledge the run', autoFailoverSafe: false } };
    }
    return { run: started.data };
  } catch (err) {
    // A start call that timed out or dropped may have reached the vendor.
    log.warn(
      { metric: 'apify_run_ambiguous', actorId, cause: 'start call did not complete' },
      'apify run start did not complete; the actor may have started',
    );
    return { failure: { success: false, error: describeTransportFailure(err), autoFailoverSafe: false } };
  }
}

/** The pre-start statuses on which a prepaid token may give way: not accepted
 *  (401), cannot pay (402), or not sold to this bearer (403, which Apify uses
 *  for an actor outside the token's eligibility). WHICH of those a refusal is
 *  cannot be read off the status, which is why the token's balance decides. */
const PREPAID_FALLBACK_STATUSES = new Set([401, 402, 403]);

export async function runApifyActor(
  actorId: string,
  input: Record<string, unknown>,
): Promise<ApifyActorRunResult> {
  let credential = await resolveApifyCredential(actorId);
  if (!credential) {
    return {
      success: false,
      error: isCooling(PLATFORM_ACCOUNT_CREDENTIAL_REF)
        ? 'the platform account cannot run this source until its usage cycle rolls over'
        : 'platform scraping is not configured',
    };
  }
  const id = toApiActorId(actorId);
  if (!id) return { success: false, error: 'no source was specified for this capability' };

  // The client deadline outlasts the run's own timeout: Apify stops the run at
  // RUN_TIMEOUT_SECONDS, and the margin is for the last poll to observe that.
  const deadline = Date.now() + (RUN_TIMEOUT_SECONDS + 15) * 1000;
  const remainingMs = () => Math.max(0, deadline - Date.now());

  let started = await startActorRun(actorId, id, input, credential, remainingMs);

  // A refused PREPAID start, keyed on the bearer rather than on whose money
  // bought the token: a Locus-funded token books as platform money, and
  // keying this on `funding === 'x402_wallet'` left it with no recourse at all.
  const refusedPrepaid = (r: typeof started): boolean =>
    'failure' in r && r.refusedStatus !== undefined && PREPAID_FALLBACK_STATUSES.has(r.refusedStatus);
  if (credential.bearer === 'prepaid' && credential.purchaseId !== undefined && refusedPrepaid(started)) {
    const purchaseId = credential.purchaseId;
    log.warn(
      {
        metric: 'apify_prepaid_refused',
        actorId,
        status: 'failure' in started ? started.refusedStatus : null,
        purchaseId,
        // The vendor's own words. Without them the log said 403 and nothing
        // else, and 403 is the one status that means two different things.
        body: ('failure' in started ? started.refusalBody : undefined) ?? null,
      },
      'apify refused the prepaid token for this actor before starting a run',
    );
    // THE TOKEN'S BALANCE FIRST. A refusal is not evidence that a token is
    // spent — Apify answers 403 for an actor outside its eligibility too — so
    // nothing is retired and nothing is bought until the vendor has said what
    // the token has left.
    const check = await refreshApifyPrepaidBalance(purchaseId).catch(() => ({ balanceUsd: null, retired: false }));
    const spent = check.retired || (check.balanceUsd !== null && check.balanceUsd <= 0);
    if (spent) {
      let replacement = await readLivePrepaidToken(actorId);
      if (!replacement && await buyPrepaidToken('the prepaid token a run was refused on is spent')) {
        replacement = await readLivePrepaidToken(actorId);
      }
      if (replacement) {
        log.info(
          { metric: 'apify_prepaid_replaced', actorId, spentPurchaseId: purchaseId, purchaseId: replacement.id },
          'the prepaid token a run was refused on is spent; another one takes the run',
        );
        credential = prepaidCredential(replacement);
        started = await startActorRun(actorId, id, input, credential, remainingMs);
      }
    } else {
      // A healthy token the vendor refused for THIS actor. Keep it, buy
      // nothing, and let the account take the run.
      log.info(
        { metric: 'apify_prepaid_actor_ineligible', actorId, purchaseId, balanceUsd: check.balanceUsd },
        'apify refused a healthy prepaid token for this actor; the refusal is the actor\'s, not the token\'s',
      );
    }
    // Still refused, or nothing to replace it with: the platform account, if
    // it is there and not parked.
    if (refusedPrepaid(started)) {
      const account = platformAccountToken();
      if (account) {
        credential = { token: account, funding: 'platform_key', bearer: 'account' };
        started = await startActorRun(actorId, id, input, credential, remainingMs);
      }
    }
  }
  if ('failure' in started) {
    // The platform account has spent its month. Park THAT account — not the
    // Apify route — until its usage cycle rolls over, so the prepaid tokens
    // go on being used and no other call spends a turn rediscovering this.
    if (credential.bearer === 'account' && started.platformLimit === true) {
      await parkPlatformAccount(credential.token, actorId);
    }
    return started.failure;
  }
  const { token, funding, purchaseId } = credential;
  let run: ApifyRun = started.run;

  // A run exists from here on. Every failure below is one the vendor may
  // already have charged for, and none of them can be answered by starting
  // another paid run from this call: the result carries the run id for the
  // reconciler and says so. Every one of them draws the token down too, so
  // each settles the balance on its way out exactly as the success path does.
  const startedRunFailed = async (error: string): Promise<ApifyActorRunResult> => {
    log.warn(
      { metric: 'apify_run_ambiguous', actorId, runId: run.id, cause: error },
      'apify run started and did not complete cleanly; not safe to start another',
    );
    if (purchaseId) await settlePrepaidBalance(purchaseId, run.id);
    return { success: false, error, runId: run.id, autoFailoverSafe: false, fundingSource: funding, ...carriedCost(run) };
  };

  // Wait on THIS run until Apify reports a terminal status, or our deadline
  // passes (by which point the run's own timeout has already fired).
  try {
    while (!TERMINAL_STATUSES.has(run.status) && remainingMs() > 0) {
      const waitSecs = Math.max(1, Math.min(MAX_WAIT_FOR_FINISH_SECONDS, Math.ceil(remainingMs() / 1000)));
      const polled = await fetchRun(run.id, token, waitSecs);
      if (!polled) return startedRunFailed('the source could not be reached');
      run = polled;
    }
  } catch (err) {
    return startedRunFailed(describeTransportFailure(err));
  }
  if (!TERMINAL_STATUSES.has(run.status)) {
    return startedRunFailed('the source timed out');
  }
  if (run.status !== 'SUCCEEDED') {
    const error = run.status === 'TIMED-OUT'
      ? 'the source timed out'
      : `the source returned an error (run ${run.status})${run.statusMessage ? `: ${run.statusMessage.slice(0, 200)}` : ''}`;
    return startedRunFailed(error);
  }

  let items: unknown[];
  try {
    const itemsResp = await fetch(
      `${APIFY_BASE}/actor-runs/${encodeURIComponent(run.id)}/dataset/items?limit=${MAX_ITEMS}&format=json`,
      { headers: authHeaders(token), signal: AbortSignal.timeout(30_000) },
    );
    if (!itemsResp.ok) {
      return startedRunFailed(`the source returned an error (${itemsResp.status})`);
    }
    const parsed = (await itemsResp.json().catch(() => [])) as unknown;
    items = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return startedRunFailed(describeTransportFailure(err));
  }

  // Cost is booked from THIS run's usageTotalUsd, read fresh after the run is
  // terminal — and, for an actor that charges per result, re-read until those
  // charges have landed. Best-effort, so a run never fails over a billing
  // read; undefined books nothing (the conservative miss), and is visible in
  // the log.
  const costUsd = await readRunCost(run, token, items.length);
  if (purchaseId) await settlePrepaidBalance(purchaseId, run.id);
  return { success: true, items, costUsd, runId: run.id, fundingSource: funding };
}

/**
 * Re-read a prepaid token's balance after the run that drew on it, INSIDE the
 * request that started it.
 *
 * Not a `setTimeout(…, 120s).unref()`: on Cloud Run that is a timer that does
 * not fire. CPU is throttled between requests and an unref'd timer holds
 * nothing open, so the instance is frozen or recycled long before it comes
 * due, and the token's row keeps the balance from BEFORE the run: no write,
 * and no failure logged either, because the callback never runs at all. A
 * deferred read is not a read.
 *
 * Inline it always lands, and it costs one GET on a call that has already
 * spent a minute. The figure can still lag the vendor's own accounting — per
 * result charges settle seconds after a run turns terminal, which is what
 * `readRunCost` has just waited on — so it is not the last word: the hourly
 * upkeep re-reads every live token, and nothing spends a token without reading
 * its balance first (readLivePrepaidToken). This is what keeps the row honest
 * between those.
 *
 * Never throws. A run that succeeded must not be reported failed because a
 * bookkeeping read did not answer.
 */
async function settlePrepaidBalance(purchaseId: string, runId: string): Promise<void> {
  try {
    const check = await refreshApifyPrepaidBalance(purchaseId);
    log.info(
      { metric: 'apify_prepaid_balance_after_run', runId, purchaseId, balanceUsd: check.balanceUsd, retired: check.retired },
      'prepaid token balance re-read after the run it funded',
    );
  } catch (error) {
    log.warn(
      { metric: 'apify_prepaid_balance_after_run_failed', runId, purchaseId, error: (error as Error).message },
      'prepaid token balance could not be re-read after the run it funded',
    );
  }
}

function describeTransportFailure(err: unknown): string {
  const name = (err as Error)?.name;
  return name === 'AbortError' || name === 'TimeoutError' ? 'the source timed out' : 'the source could not be reached';
}

/** When the platform account's current usage cycle ends, from Apify's own
 *  account-limits answer (`GET /v2/users/me/limits` →
 *  `data.monthlyUsageCycle.endAt`). Null when it cannot be read; the caller
 *  then parks for the short fallback rather than guessing a month. */
async function apifyUsageCycleEnd(token: string): Promise<Date | null> {
  try {
    const resp = await fetch(`${APIFY_BASE}/users/me/limits`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json().catch(() => null)) as { data?: { monthlyUsageCycle?: { endAt?: string } } } | null;
    const endAt = body?.data?.monthlyUsageCycle?.endAt;
    if (typeof endAt !== 'string') return null;
    const at = Date.parse(endAt);
    return Number.isFinite(at) ? new Date(at) : null;
  } catch (error) {
    log.debug({ error }, 'apify account limits read failed; the platform account parks for the fallback window');
    return null;
  }
}

/** Park the platform ACCOUNT — and only it — until its usage cycle rolls
 *  over. Never `internal:apify`: that key is checked before every platform
 *  Apify rung, so parking it stops the prepaid tokens the account's limit has
 *  nothing to do with. */
async function parkPlatformAccount(token: string, actorId: string): Promise<void> {
  const cycleEnd = await apifyUsageCycleEnd(token);
  const untilCycleEnd = cycleEnd ? cycleEnd.getTime() - Date.now() : 0;
  const durationMs = untilCycleEnd > 0
    ? Math.min(untilCycleEnd, PLATFORM_LIMIT_PARK_MAX_MS)
    : PLATFORM_LIMIT_PARK_FALLBACK_MS;
  log.error(
    {
      event: 'apify_platform_account_limit',
      actorId,
      credentialRef: PLATFORM_ACCOUNT_CREDENTIAL_REF,
      usageCycleEndsAt: cycleEnd ? cycleEnd.toISOString() : null,
      parkedForMs: durationMs,
    },
    'the platform Apify account has spent its monthly hard limit; parking that account until its usage cycle rolls over',
  );
  await parkCredential({
    credentialRef: PLATFORM_ACCOUNT_CREDENTIAL_REF,
    connectorType: 'apify',
    tenantId: null,
    reason: 'payment',
    durationMs,
  });
}

/** The two start-call statuses that mean the ACCOUNT failed. 401: the token
 *  is not accepted. 402: the account cannot pay. Nothing else — a 403 is a
 *  resource or plan refusal and a 429 clears on its own; neither is a dead
 *  credential. The one exception is Apify's `platform-feature-disabled` 403,
 *  which is read by its error TYPE (not its status) and parks the platform
 *  account alone rather than the whole Apify route. */
function accountFailureForStatus(status: number): 'auth' | 'payment' | null {
  if (status === 401) return 'auth';
  if (status === 402) return 'payment';
  return null;
}

/** The cost a run's record already carries, for a failed run: the vendor
 *  charges for the compute whether or not the actor succeeded, and a charge
 *  the vendor reported is booked under the attempt's own key. Nothing when
 *  the record carries no positive figure; the reconciler picks up a charge
 *  that lands later. */
function carriedCost(run: ApifyRun): { costUsd?: number } {
  return typeof run.usageTotalUsd === 'number' && run.usageTotalUsd > 0 ? { costUsd: run.usageTotalUsd } : {};
}

/** One read of a run, holding the request open up to `waitForFinishSecs` for
 *  the run to reach a terminal status. Null when the read itself failed. */
async function fetchRun(runId: string, token: string, waitForFinishSecs: number): Promise<ApifyRun | null> {
  const resp = await fetch(
    `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${waitForFinishSecs}`,
    { headers: authHeaders(token), signal: AbortSignal.timeout((waitForFinishSecs + 10) * 1000) },
  );
  if (!resp.ok) return null;
  const body = (await resp.json().catch(() => null)) as { data?: ApifyRun } | null;
  return body?.data?.id ? body.data : null;
}

/** The USD cost of one run, by id, read after the run is terminal.
 *
 *  Usage is accounted at the end of a run, but not all of it at once: the
 *  compute charge is on the run the moment it is terminal, and an actor's own
 *  per-result charges (PAY_PER_EVENT, PRICE_PER_DATASET_ITEM) are posted by the
 *  vendor's accounting a few seconds later. A read taken at the status flip
 *  books such a run at its start fee alone, which is how a 15-post run was
 *  booked at $0.0005 against the $0.0305 the vendor charged. So when the run
 *  returned items under a per-result model, this polls the run until its
 *  event counts show the results were charged and the USD figure has moved,
 *  bounded by SETTLEMENT_WAIT_MS. A figure that had not settled by then is
 *  booked as it stands and logged for the reconciler. */
async function readRunCost(
  terminalRun: ApifyRun,
  token: string,
  itemsReturned: number,
): Promise<number | undefined> {
  const carried = typeof terminalRun.usageTotalUsd === 'number' ? terminalRun.usageTotalUsd : undefined;
  const perResult = PER_RESULT_PRICING_MODELS.has(terminalRun.pricingInfo?.pricingModel ?? '');
  const expectSettlement = perResult && itemsReturned > 0;
  const deadline = Date.now() + SETTLEMENT_WAIT_MS;
  let latest: ApifyRun | null = null;
  let polls = 0;
  try {
    for (;;) {
      polls += 1;
      const resp = await fetch(
        `${APIFY_BASE}/actor-runs/${encodeURIComponent(terminalRun.id)}`,
        { headers: authHeaders(token), signal: AbortSignal.timeout(10_000) },
      );
      if (!resp.ok) {
        log.warn({ runId: terminalRun.id, status: resp.status }, 'apify run cost read failed; using the figure the run carried');
        return carried !== undefined && carried > 0 ? carried : undefined;
      }
      const body = (await resp.json().catch(() => null)) as { data?: ApifyRun } | null;
      latest = body?.data ?? null;
      if (!expectSettlement || settled(latest, carried)) break;
      if (Date.now() + SETTLEMENT_POLL_MS > deadline) {
        log.warn(
          {
            metric: 'apify_run_cost_unsettled',
            runId: terminalRun.id,
            waitedMs: SETTLEMENT_WAIT_MS,
            usd: latest?.usageTotalUsd ?? null,
            chargedEventCounts: latest?.chargedEventCounts ?? null,
          },
          'apify per-result charges had not settled within the wait; booking the figure as it stands',
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLEMENT_POLL_MS));
    }
    const settledUsd = latest?.usageTotalUsd;
    const usd = typeof settledUsd === 'number' ? settledUsd : carried;
    if (typeof settledUsd === 'number' && carried !== undefined && settledUsd !== carried) {
      log.info(
        { metric: 'apify_run_cost_settled_late', runId: terminalRun.id, carriedUsd: carried, settledUsd, polls },
        'apify run cost settled after the terminal poll',
      );
    }
    if (usd === undefined || usd <= 0) {
      log.warn({ runId: terminalRun.id, usd: usd ?? null }, 'apify run reported no cost; nothing will be booked');
      return undefined;
    }
    return usd;
  } catch (err) {
    log.warn({ runId: terminalRun.id, err: (err as Error).message }, 'apify run cost read threw; using the figure the run carried');
    return carried !== undefined && carried > 0 ? carried : undefined;
  }
}

/** Whether a per-result run's charges have landed: the vendor's event counts
 *  include at least one charged result AND the USD figure has moved past what
 *  the run carried at the status flip. Both, because the counts arrive a few
 *  seconds before the dollars do. */
function settled(run: ApifyRun | null, carriedUsd: number | undefined): boolean {
  if (!run) return false;
  const counts = run.chargedEventCounts ?? {};
  const resultsCharged = Object.entries(counts).some(
    ([event, n]) => event !== 'apify-actor-start' && typeof n === 'number' && n > 0,
  );
  const usd = run.usageTotalUsd;
  const moved = typeof usd === 'number' && (carriedUsd === undefined || usd > carriedUsd);
  return resultsCharged && moved;
}

/** The actor's COMPLETE input schema, from its default build, or null when it
 *  cannot be had — no token, a failed fetch, a build with no schema. The full
 *  document, not a summary: the execution chain validates a fallback's
 *  arguments against it before running anything automatically, and a
 *  truncated hint cannot validate types or nested requirements. Null never
 *  authorises a run. Never throws. Cached per process. */
const inputSchemaCache = new Map<string, unknown>();
export async function fetchApifyActorInputSchema(actorId: string): Promise<unknown | null> {
  const id = toApiActorId(actorId);
  if (inputSchemaCache.has(id)) return inputSchemaCache.get(id) ?? null;
  const token = process.env.APIFY_PLATFORM_TOKEN;
  if (!token || !token.trim()) return null;
  try {
    const resp = await fetch(`${APIFY_BASE}/acts/${encodeURIComponent(id)}/builds/default`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data?: { inputSchema?: string } };
    const raw = body.data?.inputSchema;
    if (!raw) return null;
    const schema: unknown = JSON.parse(raw);
    if (!schema || typeof schema !== 'object') return null;
    inputSchemaCache.set(id, schema);
    return schema;
  } catch (error) {
    log.debug({ error, actorId }, 'apify input-schema fetch failed; no schema');
    return null;
  }
}

/** Best-effort input fields for the model — name, type, whether required —
 *  read from the actor's default build input schema, so capability_search can
 *  show what a capability needs. A display hint over the full schema above;
 *  an empty list just means no hint. Never throws. */
export async function fetchApifyActorInputFields(actorId: string): Promise<ArgSummary[]> {
  const schema = await fetchApifyActorInputSchema(actorId);
  return schema ? summarizeArgs(schema, 12) : [];
}
