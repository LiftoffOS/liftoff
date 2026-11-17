// Agent Performance-Understanding Harness — CLI entrypoint.
//
// Runs in two homes (plan Architecture): the smoke image (canary gate) and a
// Cloud Run Job (passive pass). Modes:
//   --discover      list the eval targets (the four agents on our eval tenant)
//   --harvest       passive: evaluate recent REAL runs → scorecards + clusters
//                   → BigQuery + agent_health metrics (alert, non-blocking)
//   --run           active: fire synthetic canary runs → evaluate → emit
//                   canary_run_outcome; EXIT NONZERO on a deterministic gating
//                   failure (the dev build-gate / prod rollback trigger)
//   --investigate   reconstruct + fully evaluate (incl. RCA) ONE run by key
//
// Cloud Run Job invocation mirrors the other src/scripts/* jobs (loadSecretsToEnv
// then node dist/scripts/agent-diagnostics.js --<mode>).

import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import { logger as log } from '../infrastructure/logging';
import type { AgentKind, RunRef } from '../diagnostics/reconstruct/trace-model';
import { RUNTIME_FOR_AGENT } from '../diagnostics/reconstruct/trace-model';
import { harvest, type PassiveTarget, type PassiveRunResult } from '../diagnostics/driver/passive';
import { parseFleetTenants, resolveFleetEndpoints, discoverFleetEndpoints, type HarvestEndpoint } from '../diagnostics/fleet';
import { driveScenario, driverConfigured, type ActiveScenario } from '../diagnostics/driver/active';
import { TenantRuntimeAdapter } from '../diagnostics/adapters/tenant-runtime';
import { WorkforceAdapter } from '../diagnostics/adapters/workforce';
import { InsightsAdapter } from '../diagnostics/adapters/insights';
import { evaluateRun, type EvaluatedRun } from '../diagnostics/analyze/evaluate';
import { ARG_FAIL_THRESHOLD } from '../diagnostics/analyze/critics/schema-validity';
import { calibrateJudges, type LabeledRun } from '../diagnostics/analyze/judge/calibrate';
import { buildScorecard } from '../diagnostics/report/scorecard';
import { clusterFailures } from '../diagnostics/report/cluster';
import { sinkScorecards, sinkClusters, sinkRunResults, sinkCalibrationReports, emitCanaryOutcome, emitAgentHealth, rollingGoalBaseline, rollingDeliverableBaseline } from '../diagnostics/report/sink';
import { closeCrossServicePools } from '../diagnostics/adapters/cross-db';

const ALL_AGENTS: AgentKind[] = ['user-created', 'caio', 'hrbp', 'insights'];

// --- regression thresholds that drive block-dev / rollback+alert-prod (plan §5).
const GOAL_REGRESSION_DROP = 0.15; // 15-pt drop vs rolling baseline (env-tunable)
const BASELINE_GOAL_SUCCESS = Number(process.env.DIAGNOSTICS_BASELINE_GOAL_SUCCESS ?? '0.8');

function evalTenant(): string {
  const t = process.env.DIAGNOSTICS_EVAL_TENANT_ID;
  if (!t) throw new Error('DIAGNOSTICS_EVAL_TENANT_ID is required');
  return t;
}

function agentIdFor(kind: AgentKind): string {
  const map: Record<AgentKind, string | undefined> = {
    'user-created': process.env.DIAGNOSTICS_USER_AGENT_ID,
    caio: process.env.DIAGNOSTICS_CAIO_AGENT_ID,
    hrbp: process.env.DIAGNOSTICS_HRBP_AGENT_ID,
    insights: process.env.DIAGNOSTICS_INSIGHTS_AGENT_ID,
  };
  return map[kind] ?? '00000000-0000-0000-0000-000000000000';
}

function adapterFor(kind: AgentKind) {
  switch (RUNTIME_FOR_AGENT[kind]) {
    case 'tenant-runtime':
      return new TenantRuntimeAdapter();
    case 'workforce-service':
      return new WorkforceAdapter();
    case 'platform-backend':
      return new InsightsAdapter();
  }
}

function parseAgentsArg(argv: string[]): AgentKind[] {
  const i = argv.indexOf('--agents');
  if (i === -1) return ALL_AGENTS;
  const csv = argv[i + 1] ?? '';
  const picked = csv.split(',').map((s) => s.trim()).filter((s): s is AgentKind => (ALL_AGENTS as string[]).includes(s));
  return picked.length ? picked : ALL_AGENTS;
}

async function modeDiscover(agents: AgentKind[]): Promise<void> {
  const tenantId = evalTenant();
  for (const kind of agents) {
    const adapter = adapterFor(kind);
    const refs = await adapter.listRecent({ tenantId, agentId: agentIdFor(kind), agentKind: kind, limit: 10 });
    log.info({ message: 'discover', agent: kind, recentRuns: refs.length, keys: refs.map((r) => r.key) });
  }
}

// OIDC ingress: agent-service requires a Google-signed ID token whose `aud`
// matches the Cloud Run service URL (run.invoker is enforced at the platform
// layer before our handler runs — same pattern as harvest-service and
// push-endpoint-healthcheck). The `agent-diagnostics` job SA is granted
// run.invoker on the eval-tenant agent-service in the tenant-runtime-template.
const oidcAuth = new GoogleAuth();
const oidcClientCache = new Map<string, IdTokenClient>();
async function trIngressHeaders(serviceUrl: string): Promise<Record<string, string>> {
  const audience = new URL(serviceUrl).origin;
  let client = oidcClientCache.get(audience);
  if (!client) {
    client = await oidcAuth.getIdTokenClient(audience);
    oidcClientCache.set(audience, client);
  }
  const headers = await client.getRequestHeaders();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Harvest tenant-runtime (user-created) targets by calling the in-TR harvest
 *  endpoint. The job runs in the control project and can't reach the per-tenant
 *  TR DB, and user-created evaluation needs the live tool-gateway — so TR
 *  reconstructs + evaluates in-process and returns the EvaluatedRun results,
 *  which we sink here. URL is derived from DIAGNOSTICS_TR_HARNESS_URL (the
 *  run-agent endpoint the active driver uses) by swapping the trailing path.
 *
 *  Auth mirrors harvest-service's control-plane → tenant-runtime calls:
 *  Google OIDC ID token for the Cloud Run ingress (run.invoker) PLUS the
 *  `X-Service-Auth` shared secret the test-harness router verifies against
 *  TENANT_RUNTIME_SERVICE_TOKEN (requireServiceAuth, app layer). */
function defaultEndpoint(): HarvestEndpoint {
  return {
    harnessUrl: process.env.DIAGNOSTICS_TR_HARNESS_URL,
    serviceToken: process.env.DIAGNOSTICS_SERVICE_TOKEN,
  };
}

async function harvestViaTR(
  target: PassiveTarget,
  opts: { limit: number; sinceIso?: string; runJudges: boolean; runRca: boolean; runGrader?: boolean; graderJudges?: string; rubricModel?: string },
  endpoint: HarvestEndpoint = defaultEndpoint(),
): Promise<PassiveRunResult[]> {
  const runAgentUrl = endpoint.harnessUrl;
  if (!runAgentUrl) {
    log.warn({ message: 'harness URL unset — skipping tenant-runtime harvest', agent: target.agentKind, tenant: target.tenantId });
    return [];
  }
  const url = runAgentUrl.replace(/\/run-agent\/?$/, '/harvest');
  const token = endpoint.serviceToken;
  try {
    const ingressHeaders = await trIngressHeaders(url);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...ingressHeaders,
        ...(token ? { 'X-Service-Auth': token } : {}),
      },
      body: JSON.stringify({
        agentKind: target.agentKind,
        tenantId: target.tenantId,
        // Evaluate ALL active agents on the tenant (discovered in-TR from the
        // invocations source of truth), not the single configured agentId. The
        // returned refs carry each run's real agentId for per-agent scorecards.
        allAgents: true,
        maxAgents: Number(process.env.DIAGNOSTICS_MAX_AGENTS ?? '25'),
        limit: opts.limit,
        sinceIso: opts.sinceIso,
        runJudges: opts.runJudges,
        runRca: opts.runRca,
        runGrader: opts.runGrader,
        graderJudges: opts.graderJudges,
        rubricModel: opts.rubricModel,
      }),
    });
    if (!res.ok) {
      log.warn({ message: 'tenant-runtime harvest endpoint non-200', agent: target.agentKind, status: res.status });
      return [];
    }
    const body = (await res.json()) as { results?: PassiveRunResult[] };
    return body.results ?? [];
  } catch (err) {
    log.warn({ message: 'tenant-runtime harvest call failed', agent: target.agentKind, err: (err as Error).message });
    return [];
  }
}

/** Evaluate ONE specific run (the active canary's just-driven synthetic run) IN
 *  tenant-runtime, via the /harvest endpoint's invocationId path. user-created
 *  reconstruction needs the tenant-local DB + tool-gateway, which the control
 *  job cannot reach — so the canary drives via /run-agent then evaluates here.
 *  Returns the EvaluatedRun, or null if the call/eval failed. */
async function evaluateRefViaTR(
  ref: RunRef,
  opts: { runJudges: boolean; runRca: boolean },
): Promise<EvaluatedRun | null> {
  const runAgentUrl = process.env.DIAGNOSTICS_TR_HARNESS_URL;
  if (!runAgentUrl) {
    log.warn({ message: 'DIAGNOSTICS_TR_HARNESS_URL unset — cannot evaluate canary run in tenant-runtime', agent: ref.agentKind });
    return null;
  }
  const url = runAgentUrl.replace(/\/run-agent\/?$/, '/harvest');
  const token = process.env.DIAGNOSTICS_SERVICE_TOKEN;
  try {
    const ingressHeaders = await trIngressHeaders(url);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ingressHeaders, ...(token ? { 'X-Service-Auth': token } : {}) },
      body: JSON.stringify({
        agentKind: ref.agentKind,
        tenantId: ref.tenantId,
        agentId: ref.agentId,
        invocationId: ref.key,
        runJudges: opts.runJudges,
        runRca: opts.runRca,
      }),
    });
    if (!res.ok) {
      log.warn({ message: 'canary: in-TR evaluate endpoint non-200', agent: ref.agentKind, status: res.status });
      return null;
    }
    const body = (await res.json()) as { results?: PassiveRunResult[] };
    const r = body.results?.[0];
    if (!r || !r.evaluated) {
      log.warn({ message: 'canary: in-TR evaluate returned no EvaluatedRun', agent: ref.agentKind, err: r?.error });
      return null;
    }
    return r.evaluated;
  } catch (err) {
    log.warn({ message: 'canary: in-TR evaluate call failed', agent: ref.agentKind, err: (err as Error).message });
    return null;
  }
}

async function modeHarvest(agents: AgentKind[], computedAt: string): Promise<void> {
  const tenantId = evalTenant();
  const targets: PassiveTarget[] = agents.map((kind) => ({ agentKind: kind, tenantId, agentId: agentIdFor(kind) }));
  const limit = Number(process.env.DIAGNOSTICS_HARVEST_LIMIT ?? '20');
  const sinceIso = process.env.DIAGNOSTICS_SINCE_ISO;
  // Grading is deliberately NOT run here. The full harvest is a single
  // synchronous request that reconstructs + evaluates every discovered run;
  // grading roughly doubles per-run LLM cost and would blow the request timeout
  // at any real tenant scale. Deliverable grading runs out-of-band, bounded and
  // incremental, via `--collab-grade` (modeCollabGrade).
  const opts = {
    limit,
    sinceIso,
    runJudges: true,
    runRca: true,
  };

  // tenant-runtime (user-created) runs are harvested IN tenant-runtime via the
  // /harvest endpoint (DB + tool-gateway are tenant-local); workforce/insights
  // DBs are in the control VPC, so those harvest locally in this job.
  const trTargets = targets.filter((t) => RUNTIME_FOR_AGENT[t.agentKind] === 'tenant-runtime');
  const localTargets = targets.filter((t) => RUNTIME_FOR_AGENT[t.agentKind] !== 'tenant-runtime');
  const results: PassiveRunResult[] = [
    ...(localTargets.length ? await harvest(localTargets, opts) : []),
    ...(await Promise.all(trTargets.map((t) => harvestViaTR(t, opts)))).flat(),
  ];
  await groupAndSink(results, tenantId, computedAt, agents);

  // B5 — fleet harvest: eval harvest is DEFAULT for every active tenant. Auto-discover the fleet
  // from PB (all execution-enabled tenants with a runtime_url), so no manual per-tenant
  // enrollment is required. Fall back to the static DIAGNOSTICS_FLEET_TENANTS CSV only when
  // discovery is unavailable (PB unreachable / token unset). Each tenant's results are sunk in
  // ISOLATION (no cross-tenant scorecard merge). The primary tenant is already harvested above,
  // so exclude it from the fleet to avoid double-processing.
  const discovered = await discoverFleetEndpoints();
  const fleet = (discovered.length > 0
    ? discovered
    : resolveFleetEndpoints(parseFleetTenants(process.env.DIAGNOSTICS_FLEET_TENANTS))
  ).filter((f) => f.tenantId !== tenantId);
  for (const { tenantId: fleetTenant, endpoint } of fleet) {
    const fleetTargets: PassiveTarget[] = agents
      .filter((kind) => RUNTIME_FOR_AGENT[kind] === 'tenant-runtime')
      .map((kind) => ({ agentKind: kind, tenantId: fleetTenant, agentId: agentIdFor(kind) }));
    if (fleetTargets.length === 0) continue;
    const fleetResults = (await Promise.all(fleetTargets.map((t) => harvestViaTR(t, opts, endpoint)))).flat();
    log.info({ message: 'fleet harvest', tenant: fleetTenant, targets: fleetTargets.length, results: fleetResults.length });
    await groupAndSink(fleetResults, fleetTenant, computedAt, agents);
  }
}

/** Group evaluated runs by (agentKind, agentId) FROM THE RUN REFS and sink scorecards / clusters
 *  / run-results + emit agent_health. Called once per tenant so fleet tenants never merge
 *  scorecards; each discovered user-created agent gets its OWN scorecard rather than merging
 *  every agent's runs under one configured id. */
async function groupAndSink(
  results: PassiveRunResult[],
  tenantId: string,
  computedAt: string,
  agents: AgentKind[],
): Promise<void> {
  const groups = new Map<string, { kind: AgentKind; agentId: string; runs: EvaluatedRun[] }>();
  for (const r of results) {
    if (!r.evaluated) continue;
    const gkey = `${r.ref.agentKind}::${r.ref.agentId}`;
    let g = groups.get(gkey);
    if (!g) {
      g = { kind: r.ref.agentKind, agentId: r.ref.agentId, runs: [] };
      groups.set(gkey, g);
    }
    g.runs.push(r.evaluated);
  }
  const seenKinds = new Set([...groups.values()].map((g) => g.kind));
  for (const kind of agents) {
    if (!seenKinds.has(kind)) log.info({ message: 'harvest: no runs for agent', agent: kind });
  }

  for (const { kind, agentId, runs: evaluated } of groups.values()) {
    const scorecard = buildScorecard(kind, tenantId, agentId, evaluated, computedAt);
    const clusters = clusterFailures(evaluated);
    // Per-agent rolling baseline from prior scorecards — read BEFORE writing this
    // run's, so it reflects history, not itself. Falls back to the static const
    // when there's no history yet.
    const baseline = (await rollingGoalBaseline(kind, 5)) ?? BASELINE_GOAL_SUCCESS;
    await sinkScorecards([scorecard]);
    await sinkClusters(kind, agentId, clusters, computedAt);
    await sinkRunResults(
      evaluated.map((e) => ({
        agent: kind,
        agentId,
        key: e.ref.key,
        computedAt,
        gating: e.gating,
        findingCount: e.findings.length,
        toolCorrectness: e.metrics.toolCorrectness,
        stepEfficiency: e.metrics.stepEfficiency,
        goalPass: e.goal?.pass ?? null,
        conformancePass: e.conformanceJudge?.pass ?? null,
        argValidity: e.argValidity?.score ?? null,
        argAppropriatenessPass: e.argJudge && !e.argJudge.unavailable ? e.argJudge.pass : null,
        deliverableScore: e.grade?.score ?? null,
        deliverableScoreSpread: e.grade?.spread ?? null,
        rubricId: e.grade?.rubric_id ?? null,
        rcaStage: e.rca?.stage ?? null,
        _batch: `${agentId}-${computedAt}`,
      })),
    );

    // Emit agent_health metrics with regression detection (alert, non-blocking).
    const goalRate = scorecard.goalSuccessRate;
    const goalRegressed = goalRate != null && goalRate < baseline - GOAL_REGRESSION_DROP;
    if (goalRate != null) emitAgentHealth(kind, 'goal', goalRate, goalRegressed);
    emitAgentHealth(kind, 'invariant', scorecard.gatingFailureRate, scorecard.gatingFailureRate > 0);
    emitAgentHealth(kind, 'efficiency', scorecard.avgStepEfficiency, scorecard.avgStepEfficiency < 0.7);
    if (scorecard.specConformanceRate != null) emitAgentHealth(kind, 'conformance', scorecard.specConformanceRate, scorecard.specConformanceRate < baseline - GOAL_REGRESSION_DROP);
    if (scorecard.avgArgValidity != null) emitAgentHealth(kind, 'arg_validity', scorecard.avgArgValidity, scorecard.avgArgValidity < ARG_FAIL_THRESHOLD);
    if (scorecard.argAppropriatenessRate != null) emitAgentHealth(kind, 'arg_appropriateness', scorecard.argAppropriatenessRate, scorecard.argAppropriatenessRate < baseline - GOAL_REGRESSION_DROP);
    if (scorecard.avgDeliverableScore != null) {
      // Deliverable baseline is its own 0-100 per-(kind, agentId) history — never
      // the 0-1 goal baseline. Provisional 15-point drop until DS-calibrated.
      const dBaseline = (await rollingDeliverableBaseline(kind, agentId, 5)) ?? scorecard.avgDeliverableScore;
      emitAgentHealth(kind, 'deliverable_quality', scorecard.avgDeliverableScore, scorecard.avgDeliverableScore < dBaseline - 15);
    }

    log.info({ message: 'harvest scorecard', agent: kind, scorecard, topClusters: clusters.slice(0, 5) });
  }
}

/** Active canary. Drives each agent through its scenario set with k trials
 *  (pass^k) and gates on deterministic findings. Returns true when ALL
 *  CONFIGURED agents pass; UNCONFIGURED drivers are skipped (non-gating) so an
 *  under-provisioned environment never false-fails the deploy. */
async function modeRun(agents: AgentKind[], computedAt: string): Promise<boolean> {
  const tenantId = evalTenant();
  const k = Math.max(1, Number(process.env.DIAGNOSTICS_PASS_K ?? '1'));
  let allPass = true;

  for (const kind of agents) {
    const agentId = agentIdFor(kind);
    if (!driverConfigured(kind)) {
      if (process.env.DIAGNOSTICS_REQUIRE_DRIVERS === 'true') {
        // Envs that MUST gate (the deploy canary) treat an unconfigured driver
        // as a hard failure rather than a vacuous pass (Orchestration & Gating §6).
        log.error({ message: 'canary: driver not configured and DIAGNOSTICS_REQUIRE_DRIVERS=true — gate FAIL', agent: kind });
        allPass = false;
        continue;
      }
      log.info({ message: 'canary: driver not configured — skipping (non-gating)', agent: kind });
      continue;
    }
    const scenarios = await loadScenarios(kind);
    let agentPass = true;

    for (const sc of scenarios) {
      const scenario: ActiveScenario = {
        agentKind: kind,
        tenantId,
        agentId,
        // DIAGNOSTICS_RUN_OBJECTIVE overrides the scenario objective for ad-hoc
        // canary drives (e.g. exercising a specific behavior, or the sink
        // redaction path with a known-PII prompt). Unset = the scenario objective.
        objective: process.env.DIAGNOSTICS_RUN_OBJECTIVE || sc.objective,
        persona: 'a workforce operator on a tenant we own',
        maxTurns: Number(process.env.DIAGNOSTICS_MAX_TURNS ?? '3'),
      };
      // pass^k — the scenario passes only if ALL k trials pass.
      let trialsPassed = 0;
      for (let trial = 0; trial < k; trial++) {
        const passed = await runOneTrial(kind, agentId, scenario, sc.id, computedAt, trial);
        if (passed) trialsPassed++;
        else break; // short-circuit: one failing trial fails pass^k
      }
      const scPass = trialsPassed === k;
      if (!scPass) agentPass = false;
    }

    emitCanaryOutcome(kind, agentPass, { scenarios: scenarios.length, k });
    if (!agentPass) {
      allPass = false;
      log.error({ message: 'canary GATING FAILURE for agent', agent: kind });
    }
  }
  return allPass;
}

/** One scenario trial: drive → reconstruct → evaluate. Returns true on pass.
 *  Skipped drivers count as pass (non-gating). Deterministic gating only. */
async function runOneTrial(
  kind: AgentKind,
  agentId: string,
  scenario: ActiveScenario,
  scenarioId: string,
  computedAt: string,
  trial: number,
): Promise<boolean> {
  const outcome = await driveScenario(scenario);
  if ('skipped' in outcome) {
    log.info({ message: 'canary trial skipped', agent: kind, scenarioId, reason: outcome.reason });
    return true;
  }
  if ('failed' in outcome) {
    log.error({ message: 'canary trial drive failed', agent: kind, scenarioId, reason: outcome.reason });
    return false;
  }
  // Reconstruct + evaluate. tenant-runtime agents (user-created) MUST evaluate
  // IN tenant-runtime — the DB + tool-gateway are tenant-local and unreachable
  // from this control job (same inversion as the passive harvest). Other
  // runtimes (workforce/insights) reconstruct from their control-VPC DBs here.
  let evaluated: EvaluatedRun | null;
  if (RUNTIME_FOR_AGENT[kind] === 'tenant-runtime') {
    evaluated = await evaluateRefViaTR(outcome.ref, { runJudges: true, runRca: true });
    if (!evaluated) {
      log.error({ message: 'canary trial in-TR evaluate failed', agent: kind, scenarioId, key: outcome.ref.key });
      return false;
    }
  } else {
    const run = await adapterFor(kind).reconstruct(outcome.ref);
    if (!run) {
      log.error({ message: 'canary trial reconstruct failed', agent: kind, scenarioId, key: outcome.ref.key });
      return false;
    }
    // Judges run (advisory) but only deterministic findings gate.
    evaluated = await evaluateRun(run, { runJudges: true, runRca: true });
  }
  await sinkRunResults([
    { agent: kind, agentId, key: outcome.ref.key, scenarioId, trial, computedAt, canary: true, gating: evaluated.gating, findingCount: evaluated.findings.length, _batch: `${agentId}-${computedAt}-canary` },
  ]);
  if (evaluated.gating) {
    log.error({ message: 'canary trial GATING FAILURE', agent: kind, scenarioId, findings: evaluated.findings });
    return false;
  }
  return true;
}

interface DiagScenario {
  id: string;
  objective: string;
}

/** Consume the per-agent scenario sets from @liftoffos/agent-test-scenarios
 *  (CAIO_SCENARIOS / HRBP_SCENARIOS / INSIGHTS_SCENARIOS; SCENARIOS for
 *  user-created). Loaded dynamically so a not-yet-republished package degrades
 *  to a single default objective rather than failing the build. */
async function loadScenarios(kind: AgentKind): Promise<DiagScenario[]> {
  try {
    const mod = (await import('@liftoffos/agent-test-scenarios')) as unknown as Record<string, Array<{ id: string; prompt: string }> | undefined>;
    const key = kind === 'user-created' ? 'SCENARIOS' : `${kind.toUpperCase()}_SCENARIOS`;
    const set = mod[key];
    if (Array.isArray(set) && set.length > 0) {
      // For user-created keep the suite small at the gate (first few); the full
      // suite runs via the dedicated TR smoke. Other agents run their full set.
      const chosen = kind === 'user-created' ? set.slice(0, 3) : set;
      return chosen.map((s) => ({ id: s.id, objective: s.prompt }));
    }
  } catch (err) {
    log.warn({ message: 'canary: scenario set import failed; using default objective', agent: kind, err: (err as Error).message });
  }
  return [{ id: `${kind}.default`, objective: defaultObjective(kind) }];
}

/** --skill-disclosure-eval — what progressive disclosure actually costs.
 *
 *  Runs the checked-in golden set (skills/eval/disclosure-tasks.ts) twice against
 *  ONE designated agent: once with each retrieved skill's full text in the
 *  prompt, once with it behind `read_skill`. Same agent, same skills, same
 *  deployment, same minute — the mode is the only thing that differs, which is
 *  what makes the comparison worth anything.
 *
 *  Lives here rather than in its own job because this job already has what it
 *  needs: run.invoker on the eval tenant's agent-service, the harness URL, the
 *  runtime database and the credentials the seeding embeddings require. A second
 *  job would be a second copy of all of that to keep in step.
 *
 *  --agent <internalAgentId> is required and deliberately not defaulted. The run
 *  seeds ten skills onto whatever agent it is given and then sends it turns;
 *  picking one on the operator's behalf is how an eval ends up writing to a
 *  customer's agent. */
async function modeSkillDisclosureEval(argv: string[]): Promise<void> {
  const harnessUrl = process.env.DIAGNOSTICS_TR_HARNESS_URL;
  if (!harnessUrl) throw new Error('DIAGNOSTICS_TR_HARNESS_URL is required for --skill-disclosure-eval');
  const internalAgentId = argv[argv.indexOf('--agent') + 1];
  if (!argv.includes('--agent') || !internalAgentId) {
    throw new Error('--skill-disclosure-eval requires --agent <internalAgentId>');
  }
  const maxTurnsArg = argv.includes('--max-turns') ? Number(argv[argv.indexOf('--max-turns') + 1]) : NaN;

  const { runDisclosureEval, renderReport } = await import('../skills/eval/disclosure-runner');
  const report = await runDisclosureEval({
    tenantId: evalTenant(),
    internalAgentId,
    harnessUrl,
    maxTurns: Number.isFinite(maxTurnsArg) ? maxTurnsArg : 6,
  });

  // Markdown to stdout so `gcloud run jobs execute --wait` shows it in the
  // execution log, where whoever ran it is already looking.
  process.stdout.write(renderReport(report) + '\n');
}

/** κ-calibration: score the LLM judges against a ground-truth labeled set and
 *  report Cohen's κ per judge dimension. Two sources:
 *    --golden : the checked-in synthetic golden set (golden-fixtures.ts) — proves
 *               the judges with authored ground truth, no real runs needed.
 *    else     : a human-labeled JSON file at DIAGNOSTICS_LABELED_SET_PATH,
 *               reconstructed from storage (real runs).
 *  A LabeledRun carrying an inline `run` is scored directly (the golden path). */
async function modeCalibrate(): Promise<void> {
  const useGolden = process.argv.includes('--golden');
  let labeled: LabeledRun[];
  if (useGolden) {
    const { goldenLabeledSet } = await import('../diagnostics/analyze/judge/golden-fixtures');
    labeled = goldenLabeledSet();
  } else {
    const path = process.env.DIAGNOSTICS_LABELED_SET_PATH;
    if (!path) throw new Error('DIAGNOSTICS_LABELED_SET_PATH is required for --calibrate (or pass --golden)');
    const fs = await import('fs/promises');
    labeled = JSON.parse(await fs.readFile(path, 'utf8')) as LabeledRun[];
  }
  const results = await calibrateJudges(
    labeled,
    async (l) =>
      l.run ?? adapterFor(l.agentKind).reconstruct({ agentKind: l.agentKind, tenantId: l.tenantId, agentId: l.agentId, key: l.key }),
    (v) => {
      // Per-fixture verdict: surfaces exactly where the judge agrees/disagrees with
      // ground truth and why — the diagnostic behind an aggregate κ.
      log.info({
        message: 'calibration-verdict',
        dimension: v.dimension,
        id: v.id,
        human: v.human,
        judge: v.judge,
        agree: v.human === v.judge,
        reasoning: v.reasoning,
      });
    },
  );
  log.info({ message: 'calibration', labeledCount: labeled.length, golden: useGolden, results });
  if (results.some((r) => !r.trusted)) {
    log.warn({ message: 'calibration: one or more judge dimensions are BELOW the κ trust threshold — keep their alerts advisory' });
  }
}

/** Calibrate the deliverable grader against a human-labeled set. Groups by
 *  effective_config_hash so scores from different prompts/models aren't mixed;
 *  missing grades are optionally regraded on demand. Reports are aggregate-only. */
async function modeCalibrateGrader(): Promise<void> {
  const argv = process.argv.slice(2);
  const runId = argv[argv.indexOf('--run-id') + 1];
  if (!argv.includes('--run-id') || !runId) throw new Error('--calibrate-grader requires --run-id <id>');
  const labeledPath = process.env.DIAGNOSTICS_LABELED_SET_PATH;
  if (!labeledPath) throw new Error('DIAGNOSTICS_LABELED_SET_PATH is required for --calibrate-grader');
  const bucket = process.env.DIAGNOSTICS_RESULTS_BUCKET ?? process.env.TRAJECTORY_BUCKET;
  if (!bucket) throw new Error('DIAGNOSTICS_RESULTS_BUCKET (or TRAJECTORY_BUCKET) is required for --calibrate-grader');
  const regrade = argv.includes('--regrade-mismatches');

  const { loadLabeledGraderSet, fetchStoredGrade, calibrateCohorts } = await import('../diagnostics/analyze/grader/calibrate');
  const labeled = await loadLabeledGraderSet(labeledPath);
  const computedAt = new Date().toISOString();

  const pairs: Array<{ human: number; grade: import('../diagnostics/analyze/grader/score').GradeResult }> = [];
  let missing = 0;
  for (const row of labeled) {
    let grade = await fetchStoredGrade(bucket, row.session_id);
    if (!grade && regrade) grade = await regradeViaTR(row.tenant_id, row.agent_id, row.session_id);
    if (!grade) { missing++; continue; }
    pairs.push({ human: row.human_score, grade });
  }
  const reports = calibrateCohorts(pairs, runId, computedAt);
  if (reports.length) await sinkCalibrationReports(reports as unknown as Array<Record<string, unknown>>);
  log.info({ message: 'grader calibration', runId, labels: labeled.length, matched: pairs.length, missing, reports });
}

/** Regrade a single session by driving the in-TR /harvest endpoint (grader only). */
async function regradeViaTR(tenantId: string, agentId: string, invocationId: string): Promise<import('../diagnostics/analyze/grader/score').GradeResult | null> {
  const runAgentUrl = process.env.DIAGNOSTICS_TR_HARNESS_URL;
  if (!runAgentUrl) return null;
  const url = runAgentUrl.replace(/\/run-agent\/?$/, '/harvest');
  const token = process.env.DIAGNOSTICS_SERVICE_TOKEN;
  try {
    const ingressHeaders = await trIngressHeaders(url);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ingressHeaders, ...(token ? { 'X-Service-Auth': token } : {}) },
      body: JSON.stringify({ agentKind: 'user-created', tenantId, agentId, invocationId, runGrader: true, runJudges: false, runRca: false }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: Array<{ evaluated?: { grade?: import('../diagnostics/analyze/grader/score').GradeResult } }> };
    return body.results?.[0]?.evaluated?.grade ?? null;
  } catch {
    return null;
  }
}

/** One (tenant, agent, session) grade unit fanned out to the tenant collab-grade job. */
interface CollabGradeItem { tenantId: string; agentId: string; sessionId: string }

/** Parse COLLAB_GRADE_JOB (projects/<p>/locations/<r>/jobs/<n>) into its parts. */
function parseCollabGradeJob(): { project: string; region: string; name: string } {
  const raw = process.env.COLLAB_GRADE_JOB;
  if (!raw) throw new Error('COLLAB_GRADE_JOB (projects/<p>/locations/<r>/jobs/<n>) is required for --collab-grade');
  const m = /^projects\/([^/]+)\/locations\/([^/]+)\/jobs\/(.+)$/.exec(raw.trim());
  if (!m) throw new Error(`COLLAB_GRADE_JOB must be projects/<p>/locations/<r>/jobs/<n>, got: ${raw}`);
  return { project: m[1], region: m[2], name: m[3] };
}

/** Fan out ONE execution of the tenant collab-grade job for the given work item(s), passing
 *  the worklist as a base64 per-execution env override (the idiomatic Cloud Run Jobs
 *  parameterization — base64 avoids arg escaping). The tenant worker is TOLD its exact work,
 *  so it never lists the shared diagnostics namespace and tenant isolation holds by
 *  construction. Runs unbounded by any request timeout (unlike the 300s /harvest window that
 *  execution-heavy agentic grades exceed). Auth = the diagnostics SA's access token; it needs
 *  run.jobs.run on the tenant job (cross-project). Mirrors src/memory/provider-switch.ts. */
async function dispatchCollabGrade(job: { project: string; region: string; name: string }, items: CollabGradeItem[]): Promise<void> {
  const worklistB64 = Buffer.from(JSON.stringify(items), 'utf8').toString('base64');
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const tokenInfo = await client.getAccessToken();
  if (!tokenInfo.token) throw new Error('GoogleAuth returned empty access token');
  const url = `https://run.googleapis.com/v2/projects/${job.project}/locations/${job.region}/jobs/${job.name}:run`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenInfo.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ overrides: { containerOverrides: [{ env: [{ name: 'COLLAB_GRADE_WORKLIST_B64', value: worklistB64 }] }] } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<no body>');
    throw new Error(`collab-grade job run returned ${res.status}: ${body}`);
  }
}

/** Orchestrate deliverable grading (control-plane / worker split). The control plane owns
 *  cross-tenant visibility, so it LISTS the ungraded runs here (fleet-wide diagnostics read)
 *  and FANS OUT one durable tenant collab-grade job execution per run — passing the run as a
 *  per-execution override. The tenant worker computes + sinks each grade with no request-
 *  timeout cap, so execution-heavy agentic grades (rubric + sandbox judges that actually run
 *  the deliverable) that exceed the 300s /harvest window complete. Dispatch is async; grades
 *  land in diagnostics/grades/, which the next --collab-grade (skips already-graded) and
 *  --collab-export read back. DIAGNOSTICS_GRADE_BATCH caps how many are dispatched per run. */
async function modeCollabGrade(): Promise<void> {
  const bucket = process.env.COLLAB_GCS_BUCKET ?? process.env.DIAGNOSTICS_RESULTS_BUCKET ?? process.env.TRAJECTORY_BUCKET;
  if (!bucket) throw new Error('COLLAB_GCS_BUCKET (or DIAGNOSTICS_RESULTS_BUCKET/TRAJECTORY_BUCKET) is required for --collab-grade');
  const job = parseCollabGradeJob();
  const batch = Math.max(1, Number(process.env.DIAGNOSTICS_GRADE_BATCH ?? '10'));
  const { listUngradedSessions } = await import('../collab-sessions/export');
  const pending = await listUngradedSessions(bucket, batch);
  if (!pending.length) {
    log.info({ message: 'collab-grade: no ungraded sessions', bucket });
    return;
  }
  let dispatched = 0;
  let failed = 0;
  for (const s of pending) {
    try {
      await dispatchCollabGrade(job, [{ tenantId: s.tenantId, agentId: s.agentId, sessionId: s.sessionId }]);
      dispatched += 1;
    } catch (err) {
      failed += 1;
      log.warn({ message: 'collab-grade: dispatch failed', sessionId: s.sessionId, agentId: s.agentId, err: (err as Error).message });
    }
  }
  log.info({ message: 'collab-grade dispatched (async; grades land in diagnostics/grades/)', requested: pending.length, dispatched, failed });
}

/** Consolidate all collab-session objects into the single match export the
 *  governance rollup reads. Fail-closed; never touches `latest` on error. */
async function modeCollabExport(): Promise<void> {
  const bucket = process.env.COLLAB_GCS_BUCKET ?? process.env.DIAGNOSTICS_RESULTS_BUCKET ?? process.env.TRAJECTORY_BUCKET;
  if (!bucket) throw new Error('COLLAB_GCS_BUCKET (or DIAGNOSTICS_RESULTS_BUCKET/TRAJECTORY_BUCKET) is required for --collab-export');
  const argv = process.argv.slice(2);
  const exportRunId = argv[argv.indexOf('--run-id') + 1] ?? `exp-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const { runCollabExport } = await import('../collab-sessions/export');
  const meta = await runCollabExport(bucket, exportRunId, new Date().toISOString());
  log.info({ message: 'collab-export complete', exportRunId, meta });
}

/** Erase a tenant's collab objects (sessions/rubrics/grades rows + artifacts). */
async function modeCollabEraseTenant(tenantId: string): Promise<void> {
  const bucket = process.env.COLLAB_GCS_BUCKET ?? process.env.DIAGNOSTICS_RESULTS_BUCKET ?? process.env.TRAJECTORY_BUCKET;
  if (!bucket) throw new Error('COLLAB_GCS_BUCKET (or DIAGNOSTICS_RESULTS_BUCKET/TRAJECTORY_BUCKET) is required for --collab-erase-tenant');
  const { eraseTenantObjects } = await import('../collab-sessions/export');
  const res = await eraseTenantObjects(bucket, tenantId);
  log.info({ message: 'collab tenant erasure complete', tenantId, ...res });
}

/** Drive the in-TR collab backfill page by page over a closed completion window.
 *  Tenant = DIAGNOSTICS_EVAL_TENANT_ID; --since / --until are ISO timestamps. */
async function modeCollabBackfill(): Promise<void> {
  const tenantId = evalTenant();
  const argv = process.argv.slice(2);
  const sinceIso = argv[argv.indexOf('--since') + 1];
  const untilIso = argv[argv.indexOf('--until') + 1];
  if (!sinceIso || !untilIso || !argv.includes('--since') || !argv.includes('--until')) {
    throw new Error('--collab-backfill requires --since <ISO> and --until <ISO>');
  }
  const runAgentUrl = process.env.DIAGNOSTICS_TR_HARNESS_URL;
  if (!runAgentUrl) throw new Error('DIAGNOSTICS_TR_HARNESS_URL is required for --collab-backfill');
  const url = runAgentUrl.replace(/\/run-agent\/?$/, '/collab-backfill');
  const token = process.env.DIAGNOSTICS_SERVICE_TOKEN;

  let cursor: { completedAt: string; id: string } | undefined;
  let totalEmitted = 0;
  let runId = '';
  for (;;) {
    const ingressHeaders = await trIngressHeaders(url);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ingressHeaders, ...(token ? { 'X-Service-Auth': token } : {}) },
      body: JSON.stringify({ tenantId, sinceIso, untilIso, cursor }),
    });
    if (!res.ok) throw new Error(`collab-backfill endpoint non-200: ${res.status}`);
    const body = (await res.json()) as { runId: string; emitted: number; nextCursor: { completedAt: string; id: string } | null };
    runId = body.runId;
    totalEmitted += body.emitted;
    log.info({ message: 'collab-backfill page', runId, emitted: body.emitted, totalEmitted, nextCursor: body.nextCursor });
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  log.info({ message: 'collab-backfill complete', runId, totalEmitted });
}

async function modeInvestigate(key: string, kind: AgentKind): Promise<void> {
  const tenantId = evalTenant();
  const ref: RunRef = { agentKind: kind, tenantId, agentId: agentIdFor(kind), key };
  const run = await adapterFor(kind).reconstruct(ref);
  if (!run) {
    log.error({ message: 'investigate: could not reconstruct run', key });
    return;
  }
  const evaluated = await evaluateRun(run, { runJudges: true, runRca: true });
  log.info({ message: 'investigate', key, evaluated });
}

function defaultObjective(kind: AgentKind): string {
  switch (kind) {
    case 'caio':
      return 'Help me design a small workforce plan for a 3-person support team and walk it to approval.';
    case 'insights':
      return 'How are my agents performing this week and what is my cost breakdown?';
    case 'hrbp':
      return 'provision the approved throwaway plan';
    case 'user-created':
      return 'Run a simple synthetic health-check task for this agent.';
  }
}

async function main(): Promise<void> {
  // NOTE: deliberately does NOT call loadSecretsToEnv() — that bootstraps the
  // full tenant-runtime secret set (DB_PASSWORD, TENANT_RUNTIME_SERVICE_TOKEN,
  // …) which this job neither has access to nor needs. The diagnostics job gets
  // all its config from injected env (DIAGNOSTICS_*_DB_URL, OPENAI/ANTHROPIC
  // keys, DEEPEVAL_SERVICE_URL, eval tenant); providers read those env-first.
  const argv = process.argv.slice(2);
  const agents = parseAgentsArg(argv);
  // computedAt comes from the harness env (Date.now-free in libs); the script
  // entrypoint may stamp it directly.
  const computedAt = new Date().toISOString();

  try {
    if (argv.includes('--discover')) {
      await modeDiscover(agents);
    } else if (argv.includes('--harvest')) {
      await modeHarvest(agents, computedAt);
    } else if (argv.includes('--calibrate')) {
      await modeCalibrate();
    } else if (argv.includes('--collab-backfill')) {
      await modeCollabBackfill();
    } else if (argv.includes('--calibrate-grader')) {
      await modeCalibrateGrader();
    } else if (argv.includes('--collab-grade')) {
      await modeCollabGrade();
    } else if (argv.includes('--collab-export')) {
      await modeCollabExport();
    } else if (argv.includes('--skill-disclosure-eval')) {
      await modeSkillDisclosureEval(argv);
    } else if (argv.includes('--collab-erase-tenant')) {
      const i = argv.indexOf('--collab-erase-tenant');
      const t = argv[i + 1];
      if (!t) throw new Error('--collab-erase-tenant requires a tenantId');
      await modeCollabEraseTenant(t);
    } else if (argv.includes('--run')) {
      const pass = await modeRun(agents, computedAt);
      if (!pass) {
        log.error({ message: 'agent-diagnostics: canary gate FAILED — exiting nonzero' });
        process.exitCode = 1;
      }
    } else if (argv.includes('--investigate')) {
      const i = argv.indexOf('--investigate');
      const key = argv[i + 1];
      const kind = (agents[0] ?? 'user-created') as AgentKind;
      if (!key) throw new Error('--investigate requires a run key');
      await modeInvestigate(key, kind);
    } else {
      log.info({ message: 'agent-diagnostics: no mode given', usage: '--discover | --harvest | --calibrate | --calibrate-grader --run-id <id> | --collab-backfill --since <ISO> --until <ISO> | --collab-grade | --collab-export [--run-id <id>] | --collab-erase-tenant <tenantId> | --skill-disclosure-eval --agent <internalAgentId> [--max-turns n] | --run | --investigate <key> [--agents a,b]' });
    }
  } finally {
    await closeCrossServicePools();
  }
}

main().catch((err) => {
  log.error({ message: 'agent-diagnostics: fatal', err: (err as Error).message });
  process.exitCode = 1;
});
