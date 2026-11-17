// Capability discovery — fit scoring over returned candidates.
//
// Pipeline order matters and each stage has one job:
//   1. Mode filter (HARD): a wrong-mode candidate is DISCARDED, never
//      down-ranked. An official-API connector and a public-data scraper for
//      the same platform are different capabilities; ranking cannot repair a
//      category error.
//   2. Health floors (HARD, store candidates only): the dead and the unused
//      are not scored.
//   3. Judge: semantic fit from metadata. inputSupplyable 'no' DISQUALIFIES —
//      a tool the workflow cannot feed is useless at any relevance.
//   4. Deterministic modifiers: ONE route ordering, cost and speed against
//      the other ways of doing the same thing, and our own execution
//      evidence. A person wants the answer right, soon and cheap, and the
//      three are separate factors so none can hide behind another.
// The output is a ranking WITH the judge's reasons attached, so a consumer
// (and a calibration reviewer) can always see why.

import {
  COST_FACTOR_MIN,
  COST_FACTOR_UNKNOWN,
  COST_FLOOR_USD,
  DEFAULT_LATENCY_MS,
  EVIDENCE_BOOST_MAX,
  EVIDENCE_DEMOTE_MIN,
  MAX_LAST_RUN_AGE_DAYS,
  MAX_RESULTS,
  MIN_USERS_30D,
  ROUTE_WEIGHT,
  SPEED_FACTOR_MIN,
} from './config';
import type { EvidenceCounts } from './evidence';
import type {
  Candidate,
  CandidateRoute,
  CapabilitySpec,
  JudgeVerdict,
  ScoredCandidate,
} from './types';

export function passesHealthFloors(c: Candidate, now: Date = new Date()): boolean {
  if (c.source !== 'apify_store') return true;
  const users = c.stats?.users30d ?? 0;
  if (users < MIN_USERS_30D) return false;
  const lastRun = c.stats?.lastRunAt ? new Date(c.stats.lastRunAt) : null;
  if (!lastRun || Number.isNaN(lastRun.getTime())) return false;
  const ageDays = (now.getTime() - lastRun.getTime()) / 86_400_000;
  return ageDays <= MAX_LAST_RUN_AGE_DAYS;
}

export function routeOf(c: Candidate, spec: CapabilitySpec): CandidateRoute {
  if (c.source === 'native_tool') return 'native_tool';
  if (c.source === 'connector_registry') {
    return c.connectorType && spec.boundConnectorTypes.includes(c.connectorType)
      ? 'bound_connector'
      : 'platform_vendor';
  }
  // A store actor reaches an agent as absorbed procedure, not a live binding.
  return 'blueprint';
}

function judgeScore(v: JudgeVerdict): number {
  let s = v.capabilityMatch;
  if (v.inputSupplyable === 'partial') s *= 0.8;
  if (v.outputCovers === 'partial') s *= 0.8;
  if (v.outputCovers === 'no') s *= 0.4;
  if (!v.shapeMatch) s *= 0.6;
  return s;
}

/** What one call is expected to cost the customer: what it HAS cost when we
 *  have run it, else the listed or estimated price. Zero is a real answer
 *  (a free source, or the workspace's own account); undefined is not known. */
export function expectedCostUsd(c: Candidate, e: EvidenceCounts | null): number | undefined {
  if (e?.avgCostUsd !== undefined && e.successes > 0) return e.avgCostUsd;
  const usd = c.price?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : undefined;
}

/** Cheaper wins at equivalent fit, on a log scale against the cheapest known
 *  price in the batch — a rate is only meaningful relative to the other ways
 *  of doing the same thing. Ten times the cheapest loses a fifth, a hundred
 *  times two fifths; a price nobody knows sits a little behind a known one. */
export function costFactor(usd: number | undefined, cheapestUsd: number | null): number {
  if (usd === undefined) return COST_FACTOR_UNKNOWN;
  if (cheapestUsd === null) return 1;
  const floor = Math.max(cheapestUsd, COST_FLOOR_USD);
  const ratio = Math.max(usd, COST_FLOOR_USD) / floor;
  const steps = Math.min(1, Math.log10(ratio) / 2);
  return 1 - (1 - COST_FACTOR_MIN) * Math.max(0, steps);
}

/** How long the answer takes: the recorded median when we have run the
 *  candidate, the route's usual latency otherwise. A second keeps the score,
 *  ten seconds loses a tenth, a hundred a fifth. */
export function speedFactor(route: CandidateRoute, e: EvidenceCounts | null): number {
  const ms = e?.medianLatencyMs !== undefined && e.successes > 0 ? e.medianLatencyMs : (DEFAULT_LATENCY_MS[route] ?? 2_000);
  const steps = Math.min(1, Math.log10(Math.max(ms, 1_000) / 1_000) / 2);
  return 1 - (1 - SPEED_FACTOR_MIN) * Math.max(0, steps);
}

function evidenceFactor(e: EvidenceCounts | null): number {
  if (!e || e.successes + e.failures === 0) return 1;
  const rate = e.successes / (e.successes + e.failures);
  return EVIDENCE_DEMOTE_MIN + rate * (EVIDENCE_BOOST_MAX - EVIDENCE_DEMOTE_MIN);
}

/** Query relevance (the Stage-2 pre-rank) as a first-class ranking factor,
 *  normalised against the most relevant candidate in this batch. It reorders
 *  within the shortlist AND — because it is computed from the spec, not the
 *  judge — it is the signal that SURVIVES a judge timeout: a highly-relevant
 *  vendor under a neutral verdict now outranks an off-topic native tool the
 *  route-weight prior would otherwise float to the top. Kept a bounded
 *  multiplier (not the whole score) so a genuine judge verdict still leads. */
function relevanceFactor(c: Candidate, maxRelevance: number): number {
  if (maxRelevance <= 0) return 1;
  const r = Math.min(1, (c.relevance ?? 0) / maxRelevance);
  return 0.55 + 0.45 * r;
}

export interface ScoreInputs {
  spec: CapabilitySpec;
  candidates: Candidate[];
  verdicts: JudgeVerdict[];
  evidence: Map<string, EvidenceCounts>;
  blueprints: Map<string, string>;
}

export function scoreCandidates(inputs: ScoreInputs): ScoredCandidate[] {
  const { spec, candidates, verdicts, evidence, blueprints } = inputs;
  // A bound connector costs the customer no Operating Units on the vendor
  // part — the workspace pays that vendor directly — so it is priced at zero
  // here whatever the vendor charges, and the cheapest price in the batch is
  // read after that.
  const costOf = (c: Candidate): number | undefined =>
    routeOf(c, spec) === 'bound_connector' ? 0 : expectedCostUsd(c, evidence.get(`${c.source}:${c.sourceRef}`) ?? null);
  const priced = candidates.map(costOf).filter((v): v is number => v !== undefined);
  const cheapest = priced.length > 0 ? Math.min(...priced) : null;
  const maxRelevance = candidates.reduce((m, c) => Math.max(m, c.relevance ?? 0), 0);

  const scored: ScoredCandidate[] = [];
  candidates.forEach((c, i) => {
    if (c.mode !== spec.mode) return; // hard mode filter — discard, not demote
    if (!passesHealthFloors(c)) return;
    const verdict = verdicts[i];
    if (!verdict || verdict.inputSupplyable === 'no') return; // disqualified
    if (verdict.capabilityMatch === 0) return;
    const route = routeOf(c, spec);
    const ev = evidence.get(`${c.source}:${c.sourceRef}`) ?? null;
    const finalScore =
      judgeScore(verdict) *
      (ROUTE_WEIGHT[route] ?? 0.7) *
      costFactor(costOf(c), cheapest) *
      speedFactor(route, ev) *
      evidenceFactor(ev) *
      relevanceFactor(c, maxRelevance);
    scored.push({
      ...c,
      judge: verdict,
      route,
      evidence: ev,
      blueprintProcedureMd: blueprints.get(`${c.source}:${c.sourceRef}`),
      finalScore,
    });
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored.slice(0, MAX_RESULTS);
}
