// Capability discovery — tunable constants.
//
// CALIBRATION CONTRACT: every threshold here must be validated against the
// recorded role/responsibilities of real production agents before the distill
// injection ships. The harness is `npm run calibrate:capability-discovery --
// --inputs <agents.json>` (scripts/calibrate-capability-discovery.ts): it
// prints ranked candidates with the judge's reasons per agent and a top-score
// distribution, so the numbers below get chosen from evidence and the run
// that chose them gets named here. The values below are conservative starting
// points; until the run happens, the section sits behind the injection's own
// suppress-when-empty behaviour, so an uncalibrated floor fails toward
// silence, not toward bad advice.

/** Total wall-clock budget for one discoverCapabilities call.
 *
 *  A tight budget such as 4000 starves the two things this service exists to
 *  do: retrieval gets budgetMs*0.5 and the judge gets the remainder, so at 4s
 *  the connector catalog fetch (up to 3s cold) times out to zero connector
 *  candidates AND the batched judge call never finishes — every candidate falls
 *  back to a neutral verdict, leaving only native tools at a flat score.
 *  withDeadline resolves the moment the work returns, so this is a CEILING, not
 *  a fixed wait; typical latency is retrieval (~3s) + one judge call (~6s).
 *  The distill-time prefetch runs under this same ceiling: a tighter budget of
 *  its own would starve it the same way, on every distill. */
export const DEFAULT_BUDGET_MS = 20000;

/** Per-source fetch timeout inside the budget. Must exceed the connector
 *  catalog fetch's own 3s cold-fetch timeout, or the registry source returns
 *  nothing. */
export const SOURCE_TIMEOUT_MS = 8000;

/** Query cache TTL. Repeat intents cluster heavily; 15 minutes keeps a
 *  redistill after a failed first attempt warm without serving stale stats
 *  for long. */
export const CACHE_TTL_MS = 15 * 60 * 1000;

/** Candidates taken forward from each source before scoring (recall stage).
 *  Sized so the store's three queries each land their share; the judge's
 *  cost is bounded by MAX_JUDGE_CANDIDATES below, not by this. */
export const MAX_CANDIDATES_PER_SOURCE = 15;

/** Two-stage retrieve→rerank: the union of source candidates is pre-ranked by a
 *  cheap query-relevance score and TRUNCATED to this many before the LLM judge.
 *  This makes the judge's latency size-INVARIANT (bounded K, not retrieval
 *  size) — the fix for the judge timing out on large candidate sets and
 *  falling back to neutral verdicts that let the route-weight prior bury the
 *  relevant vendors. Standard first-stage-retriever → reranker bound. */
export const MAX_JUDGE_CANDIDATES = 12;

/** Ranked candidates returned per capability after scoring. */
export const MAX_RESULTS = 5;

// ── Health floors (hard filters, apify_store candidates only — registry and
//    native candidates are our own and have no third-party health signal) ──

/** Minimum 30-day active users for a store actor. Calibrated against a
 *  32-intent corpus: the store actors that surfaced (tiktok/
 *  instagram/amazon) had 90–396 users and cleared this floor comfortably; no
 *  evidence to move it. */
export const MIN_USERS_30D = 50;

/** A store actor whose last run is older than this is dying or dead. */
export const MAX_LAST_RUN_AGE_DAYS = 14;

// ── Score modifiers ──

/** One explicit route ordering. A second ordering principle is how the
 *  web-tool vendor router ended up with two competing answers to the same
 *  question; keep exactly one here. */
export const ROUTE_WEIGHT: Record<string, number> = {
  bound_connector: 1.0,
  native_tool: 0.9,
  platform_vendor: 0.8,
  blueprint: 0.7,
};

/** Below this final score a query is logged weak-fit; the weak-fit log is the
 *  roadmap/gap signal (there are no catalog census jobs). Calibrated against
 *  a 32-intent corpus: the judge-match bands were
 *  match=1 ≤0.51, match=2 0.81–1.44, match=3 1.13–2.70. The prior 1.2 sat
 *  inside the strong band and discarded genuinely useful capabilities
 *  (a match=3 at 1.13, plus every match=2). 0.75 sits in the clean gap
 *  between weak (≤0.51) and usable (≥0.81), cutting only the real non-fits. */
export const WEAK_FIT_THRESHOLD = 0.75;

/** Evidence modifier bounds: a candidate with recorded successes gets at most
 *  this boost, one with only failures at most this demotion. */
export const EVIDENCE_BOOST_MAX = 1.25;
export const EVIDENCE_DEMOTE_MIN = 0.5;

// ── Cost and speed ──
// A price is compared on a log scale against the cheapest priced candidate
// in the batch, floored at a tenth of a cent so a free source does not make
// every priced one look infinitely dear: ten times the cheapest loses a
// fifth of its score, a hundred times loses two fifths. Fit still leads —
// the judge's range is wider — so a dear tool that alone fits the need is
// still chosen, and a cheap one that fits as well wins.
export const COST_FACTOR_MIN = 0.6;
export const COST_FLOOR_USD = 0.001;
/** A candidate whose price nobody knows: a little behind a known price,
 *  never level with the cheapest. */
export const COST_FACTOR_UNKNOWN = 0.95;
/** A store actor that lists no price of its own is paid for by compute; a
 *  small run costs a few cents. Replaced by the actor's recorded cost once
 *  we have run it. */
export const APIFY_COMPUTE_ESTIMATE_USD = 0.03;
/** A per-item price is compared at the number of items a typical call
 *  returns. */
export const APIFY_NOMINAL_ITEMS = 10;
// Speed: a call that answers in a second keeps its score; ten seconds loses
// a tenth, a hundred seconds a fifth. The recorded median latency when we
// have run the candidate; a route default otherwise — a vendor call answers
// in seconds, a store actor run takes a minute.
export const SPEED_FACTOR_MIN = 0.8;
export const DEFAULT_LATENCY_MS: Record<string, number> = {
  native_tool: 1_000,
  bound_connector: 2_000,
  platform_vendor: 2_000,
  blueprint: 60_000,
};

// ── Credential cooldown ──

/** How long a credential that failed at ACCOUNT level — a 401 the wire
 *  classified as an expired credential, or an explicit payment-required
 *  response — is parked before a capability call tries it again. Ten minutes
 *  either way: a topped-up account or a re-issued key is back within minutes
 *  with nobody involved, and a wrong park costs at most one window. Read by
 *  the writer in vendor-execution.ts; the reader (vendor-gate.ts) trusts the
 *  row's own expiry. */
export const CREDENTIAL_COOLDOWN_MS: Readonly<Record<'auth' | 'payment', number>> = {
  auth: 10 * 60_000,
  payment: 10 * 60_000,
};
