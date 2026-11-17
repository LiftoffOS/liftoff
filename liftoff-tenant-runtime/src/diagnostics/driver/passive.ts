// Passive driver — collect recent REAL production runs per agent and evaluate
// them with ZERO side effects (read-only). This is the harvester the plan calls
// out as net-new gap #6: "nothing reads the sunk trajectories of real
// production runs to evaluate them."
//
// The synthetic canary gates deploys; this passive job catches what real
// traffic actually hits.

import { logger as log } from '../../infrastructure/logging';
import type { AgentKind, RuntimeAdapter, RunRef } from '../reconstruct/trace-model';
import { RUNTIME_FOR_AGENT } from '../reconstruct/trace-model';
import { TenantRuntimeAdapter } from '../adapters/tenant-runtime';
import { WorkforceAdapter } from '../adapters/workforce';
import { InsightsAdapter } from '../adapters/insights';
import { evaluateRun, type EvaluatedRun, type EvaluateOptions } from '../analyze/evaluate';

/** One adapter instance per runtime; both workforce agents share one adapter. */
function adapterFor(agentKind: AgentKind): RuntimeAdapter {
  switch (RUNTIME_FOR_AGENT[agentKind]) {
    case 'tenant-runtime':
      return new TenantRuntimeAdapter();
    case 'workforce-service':
      return new WorkforceAdapter();
    case 'platform-backend':
      return new InsightsAdapter();
  }
}

export interface PassiveTarget {
  agentKind: AgentKind;
  tenantId: string;
  agentId: string;
}

export interface PassiveOptions {
  /** Max runs to harvest per target. */
  limit: number;
  /** ISO lower bound on run recency (the passive window). */
  sinceIso?: string;
  /** Whether to run the advisory judges/RCA (passive eval = yes; near-free). */
  runJudges: boolean;
  runRca: boolean;
  /** Run the deliverable grader (user-created only). Artifact URIs are read from
   *  each run's session manifest here, in-TR, where GCS is readable. */
  runGrader?: boolean;
  graderJudges?: string;
  rubricModel?: string;
  /** 'agentic' = sandbox-backed judge; else one-shot (default). */
  graderMode?: 'oneshot' | 'agentic';
  /** Per-target conformance context (role / oversight) when known. */
  contextFor?: (ref: RunRef) => Partial<EvaluateOptions>;
}

/** Build the per-run grader options: reads the session artifact manifest so the
 *  grader scores deliverables, not just trajectory text. Non-user-created or
 *  grader-off runs get an empty override. */
async function graderOptsFor(ref: RunRef, opts: PassiveOptions): Promise<Partial<EvaluateOptions>> {
  if (!opts.runGrader || ref.agentKind !== 'user-created') return {};
  const { readManifestUris } = await import('../analyze/grader/serialize');
  const artifactUris = await readManifestUris(ref.tenantId, ref.key);
  return { runGrader: true, graderJudges: opts.graderJudges, rubricModel: opts.rubricModel, graderMode: opts.graderMode, artifactUris };
}

export interface PassiveRunResult {
  ref: RunRef;
  evaluated?: EvaluatedRun;
  error?: string;
}

/** Harvest + evaluate recent real runs for a single target. */
export async function harvestTarget(target: PassiveTarget, opts: PassiveOptions): Promise<PassiveRunResult[]> {
  const adapter = adapterFor(target.agentKind);
  let refs: RunRef[] = [];
  try {
    refs = await adapter.listRecent({
      tenantId: target.tenantId,
      agentId: target.agentId,
      agentKind: target.agentKind,
      limit: opts.limit,
      sinceIso: opts.sinceIso,
    });
  } catch (err) {
    log.warn({ message: 'passive: listRecent failed', agentKind: target.agentKind, err: (err as Error).message });
    return [];
  }

  const results: PassiveRunResult[] = [];
  // Sequential per target — passive volume is tiny and this keeps Vertex judge
  // QPS and cross-service DB load gentle.
  for (const ref of refs) {
    try {
      const run = await adapter.reconstruct(ref);
      if (!run) {
        results.push({ ref, error: 'reconstruct returned null' });
        continue;
      }
      const ctx = opts.contextFor?.(ref) ?? {};
      const grader = await graderOptsFor(ref, opts);
      const evaluated = await evaluateRun(run, { runJudges: opts.runJudges, runRca: opts.runRca, ...ctx, ...grader });
      results.push({ ref, evaluated });
    } catch (err) {
      log.warn({ message: 'passive: evaluate failed', key: ref.key, err: (err as Error).message });
      results.push({ ref, error: (err as Error).message });
    }
  }
  return results;
}

/** Discover ALL active agents on the tenant (via the adapter's listActiveAgents,
 *  reading the invocations source of truth) and harvest each — so the passive
 *  pass evaluates every active agent's real runs, not a single configured id.
 *  Per-agent harvests run concurrently; each agent's runs evaluate sequentially.
 *  Returns the flattened per-run results (refs carry the real agentId, so the
 *  caller groups per-agent scorecards). */
export async function harvestAllActiveAgents(
  tenantId: string,
  agentKind: AgentKind,
  opts: PassiveOptions & { maxAgents?: number },
): Promise<PassiveRunResult[]> {
  const adapter = adapterFor(agentKind);
  if (typeof adapter.listActiveAgents !== 'function') {
    log.warn({ message: 'passive: adapter does not support listActiveAgents', agentKind });
    return [];
  }
  let agentIds: string[] = [];
  try {
    agentIds = await adapter.listActiveAgents({ tenantId, limit: opts.maxAgents ?? 25, sinceIso: opts.sinceIso });
  } catch (err) {
    log.warn({ message: 'passive: listActiveAgents failed', agentKind, err: (err as Error).message });
    return [];
  }
  log.info({ message: 'passive: discovered active agents', agentKind, count: agentIds.length, agentIds });
  const per = await Promise.all(agentIds.map((agentId) => harvestTarget({ agentKind, tenantId, agentId }, opts)));
  return per.flat();
}

/** Reconstruct + evaluate ONE specific run by key (invocation/thread/run id),
 *  IN tenant-runtime. Used by the active deploy-canary: the control job drives a
 *  synthetic run via /run-agent (which executes in tenant-runtime), then calls
 *  this (over /harvest with an invocationId) to evaluate that exact run with the
 *  tenant-local DB + tool-gateway — the same cross-VPC reason the passive harvest
 *  evaluates in-tenant rather than in the control job. */
export async function harvestOne(target: PassiveTarget, key: string, opts: PassiveOptions): Promise<PassiveRunResult> {
  const adapter = adapterFor(target.agentKind);
  const ref: RunRef = { agentKind: target.agentKind, tenantId: target.tenantId, agentId: target.agentId, key };
  try {
    const run = await adapter.reconstruct(ref);
    if (!run) return { ref, error: 'reconstruct returned null' };
    const ctx = opts.contextFor?.(ref) ?? {};
    const grader = await graderOptsFor(ref, opts);
    const evaluated = await evaluateRun(run, { runJudges: opts.runJudges, runRca: opts.runRca, ...ctx, ...grader });
    return { ref, evaluated };
  } catch (err) {
    log.warn({ message: 'active: single-run evaluate failed', key, err: (err as Error).message });
    return { ref, error: (err as Error).message };
  }
}

/** Harvest across many targets. */
export async function harvest(targets: PassiveTarget[], opts: PassiveOptions): Promise<PassiveRunResult[]> {
  const out: PassiveRunResult[] = [];
  for (const t of targets) out.push(...(await harvestTarget(t, opts)));
  return out;
}
