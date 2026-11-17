// Shared fan-out gate: caps, depth, spawn-pause, cross-tenant. Pure checks (no
// side-effects beyond the clamp metric). delegateToAgents AND the DAG executor
// both call these so the two fan-out paths share one governed surface.
import { getPoolForService } from '../infrastructure/database';
import { getTenantRuntimeConfig } from '../tenant-runtime-config/service';
import { applyClamp, DELEGATION_DEFAULTS, DELEGATION_HARD_CAPS } from './delegation-defaults';
import { insertAuditLog } from '../audit';                      // verified: service.ts:145 imports from '../audit'
import { delegation_cross_tenant_blocked_total, delegation_spawn_paused, delegation_fanout_rejected_total }
  from '../observability/runtime-extensions-metrics';

export class DelegationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'DelegationError';
    this.code = code;
  }
}

/** A delegated child stopped for a human approval.
 *
 *  NOT a failure, and typed so no caller can mistake it for one: the child's
 *  run is alive, its approval row is in the review queue, and it resumes the
 *  moment somebody decides. What a caller cannot do is wait — the child may sit
 *  for hours, and a blocking tool call cannot — so the delegation surfaces this
 *  as its outcome and the parent reports where the decision is waiting.
 *
 *  Carries the identifiers the surfacing layers need: the approval to decide,
 *  the child run it suspends, and the agent whose name the person should see.
 *  Without a typed carrier the pause would round back into prose — which is the
 *  original defect, where a child's stop was indistinguishable from an empty
 *  answer. */
export class DelegationChildPausedError extends Error {
  readonly approvalId: string | undefined;
  readonly childInvocationId: string;
  readonly childAgentId: string;
  readonly actionSummary: string | null;
  constructor(args: {
    approvalId: string | undefined;
    childInvocationId: string;
    childAgentId: string;
    actionSummary: string | null;
    reason: string;
  }) {
    super(args.reason);
    this.name = 'DelegationChildPausedError';
    this.approvalId = args.approvalId;
    this.childInvocationId = args.childInvocationId;
    this.childAgentId = args.childAgentId;
    this.actionSummary = args.actionSummary;
  }
}

export interface DispatchGate { maxDepth: number; maxFanout: number; maxConcurrent: number; maxChildrenPerAgent: number; }

export async function loadDispatchGate(tenantId: string): Promise<DispatchGate> {
  const cfg = await getTenantRuntimeConfig(tenantId);
  return {
    maxDepth:     applyClamp(cfg.maxDelegationDepth,          DELEGATION_DEFAULTS.MAX_DEPTH,          DELEGATION_HARD_CAPS.MAX_DEPTH,          'max_delegation_depth'),
    maxFanout:    applyClamp(cfg.maxDelegationFanout,         DELEGATION_DEFAULTS.MAX_FANOUT,         DELEGATION_HARD_CAPS.MAX_FANOUT,         'max_delegation_fanout'),
    maxConcurrent:applyClamp(cfg.defaultMaxConcurrentChildren,DELEGATION_DEFAULTS.DEFAULT_CONCURRENT, DELEGATION_HARD_CAPS.DEFAULT_CONCURRENT, 'default_max_concurrent_children'),
    maxChildrenPerAgent: applyClamp(cfg.maxChildrenPerAgent,  DELEGATION_DEFAULTS.PER_AGENT_CHILDREN, DELEGATION_HARD_CAPS.PER_AGENT_CHILDREN, 'max_children_per_agent'),
  };
}

/** Refuses a new child of `agentId` when the workspace already has the capped
 *  number of that agent's delegated runs in flight.
 *
 *  This is the bound that stands in for the per-agent execution lock, which
 *  delegated children bypass on purpose (the lock would serialise a fan-out to
 *  one specialist and deadlock self-delegation). Counted from delegation_active
 *  because that registry is cross-instance — an in-memory counter would reset
 *  per Cloud Run instance and multiply the cap by the instance count. */
export async function assertChildCapacity(tenantId: string, agentId: string, gate: DispatchGate): Promise<void> {
  const pool = getPoolForService('default');
  // Only children that could PLAUSIBLY still be running count against the cap.
  //
  // Nothing reaps delegation_active, so a row is closed by the run that opened
  // it or not at all: an instance killed mid-run (deploy, OOM, SIGTERM) leaves
  // its row at 'running' forever. Counting those would make this a slow denial
  // of service on the team's own behalf — three crashes and every future
  // delegation to that team is refused, permanently, with a message about
  // runs in flight that finished hours ago.
  //
  // A run cannot outlive the Cloud Run request ceiling (900s, with the
  // runtime's own 840s timeout inside it), so anything past this window is
  // debris rather than work. Deliberately not cleaned up here: a read path
  // that writes is a surprise, and ignoring the row is enough to make the cap
  // self-healing. A paused child is already excluded — it carries status
  // 'paused', not 'running', because it may wait on a person for hours and
  // must not hold a slot.
  const row = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM delegation_active
     WHERE tenant_id = $1 AND agent_id = $2 AND status = 'running'
       AND started_at > now() - interval '30 minutes'`,
    [tenantId, agentId],
  );
  const running = Number(row.rows[0]?.n ?? 0);
  if (running >= gate.maxChildrenPerAgent) {
    throw new DelegationError(
      `Agent ${agentId} already has ${running} delegated runs in flight (cap ${gate.maxChildrenPerAgent})`,
      'child_capacity_exceeded',
    );
  }
}

export function assertFanoutWithinCap(count: number, gate: DispatchGate, tenantId?: string): void {
  if (count > gate.maxFanout) {
    if (tenantId) delegation_fanout_rejected_total.inc({ tenant_id: tenantId, reason: 'fanout_exceeded' });
    throw new DelegationError(`Fan-out ${count} exceeds cap ${gate.maxFanout}`, 'fanout_exceeded');
  }
}

/** Reads the parent's delegation_depth, throws if the child would exceed the cap,
 *  else returns the child depth (parentDepth + 1).
 *
 *  A MISSING parent row is an error, not depth 0. Reading it as 0 was a
 *  fail-open: any hop whose parent id did not resolve — a hop under an
 *  ungoverned entry point, a typo'd id, a row lost to retention — silently
 *  reset the chain's depth and the cap never bound. A NULL depth on an
 *  EXISTING row still reads as 0, because root invocations legitimately carry
 *  NULL there. */
export async function assertDepthWithinCap(parentInvocationId: string, gate: DispatchGate): Promise<number> {
  const pool = getPoolForService('default');
  const row = await pool.query<{ delegation_depth: number | null }>(
    'SELECT delegation_depth FROM invocations WHERE id = $1', [parentInvocationId]);
  if (row.rows.length === 0) {
    throw new DelegationError(`Parent invocation ${parentInvocationId} not found; refusing to reset delegation depth`, 'parent_not_found');
  }
  const parentDepth = row.rows[0].delegation_depth ?? 0;
  if (parentDepth + 1 > gate.maxDepth) throw new DelegationError(`Depth ${parentDepth + 1} exceeds cap ${gate.maxDepth}`, 'depth_exceeded');
  return parentDepth + 1;
}

/** Refuses a delegation to an agent already running somewhere up this chain.
 *
 *  The depth cap alone does not prevent a cycle, it only bounds how long one may
 *  be: A delegating to B and B delegating back to A is two hops, inside a cap of
 *  two, and every gate above passes it. What the second hop gets is a run of A
 *  at the depth limit, so `resolveDelegationRole` makes it a leaf and strips its
 *  orchestration tools — including the very tool it was asked to use. The model
 *  reaches for it anyway, and an unresolvable tool from our own gateway fails
 *  the whole invocation. The parent then re-spawns and the cycle repeats until
 *  the wall clock ends the turn with nothing to show for it.
 *
 *  Two identically-named teammates make this easy to reach by accident: a
 *  roster is presented by ROLE, so "hand this to the Research Analyst" can
 *  resolve to the twin of the agent already running.
 *
 *  Walks `parent_invocation_id` upward, which is bounded by the depth cap. A
 *  broken link is not treated as the end of the chain — same fail-closed posture
 *  as `assertDepthWithinCap`, for the same reason: a chain that cannot be read
 *  is a chain whose cycles cannot be ruled out. */
export async function assertNoDelegationCycle(
  parentInvocationId: string,
  targetAgentIds: string[],
): Promise<void> {
  const pool = getPoolForService('default');
  const chain = await pool.query<{ agent_id: string }>(
    `WITH RECURSIVE ancestry AS (
       SELECT id, agent_id, parent_invocation_id, 1 AS hop
         FROM invocations WHERE id = $1
       UNION ALL
       SELECT i.id, i.agent_id, i.parent_invocation_id, a.hop + 1
         FROM invocations i
         JOIN ancestry a ON i.id = a.parent_invocation_id
        WHERE a.hop < $2
     )
     SELECT agent_id FROM ancestry`,
    [parentInvocationId, MAX_ANCESTRY_HOPS],
  );
  if (chain.rows.length === 0) {
    throw new DelegationError(
      `Parent invocation ${parentInvocationId} not found; refusing to delegate without an ancestry to check`,
      'parent_not_found',
    );
  }
  const ancestors = new Set(chain.rows.map((r) => r.agent_id));
  // Takes the whole batch so a fan-out costs ONE ancestry read rather than one
  // per task, and so a batch containing an ancestor is refused whole: the batch
  // shares an idempotency ledger entry, and admitting some tasks while refusing
  // others would make that key describe a set that never ran.
  const offender = targetAgentIds.find((id) => ancestors.has(id));
  if (offender) {
    throw new DelegationError(
      `Agent ${offender} is already running in this delegation chain; refusing to delegate to it again`,
      'delegation_cycle',
    );
  }
}

/** Hard stop on the ancestry walk. Well above any reachable delegation depth
 *  (the cap is clamped far below it), so it bounds a corrupted parent chain
 *  rather than a legitimate one. */
const MAX_ANCESTRY_HOPS = 32;

export async function assertNotSpawnPaused(tenantId: string): Promise<void> {
  const pool = getPoolForService('default');
  const tenantScope = `tenant:${tenantId}`;
  const row = await pool.query<{ scope: string }>(
    `SELECT scope FROM delegation_spawn_pause WHERE scope IN ($1,$2)
     ORDER BY CASE scope WHEN 'global' THEN 0 ELSE 1 END LIMIT 1`, ['global', tenantScope]);
  if (row.rows.length > 0) { delegation_spawn_paused.set(1, { scope: row.rows[0].scope }); throw new DelegationError('Delegation spawn is paused', 'spawn_paused'); }
  delegation_spawn_paused.set(0, { scope: tenantScope });
}

export async function assertSameTenantAgents(tenantId: string, parentAgentId: string, agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  const pool = getPoolForService('default');
  const rows = await pool.query<{ id: string; tenant_id: string }>(
    'SELECT id, tenant_id FROM agents WHERE id = ANY($1::uuid[])', [agentIds]);
  const byId = new Map(rows.rows.map(r => [r.id, r.tenant_id]));
  for (const id of agentIds) {
    const t = byId.get(id);
    if (!t) throw new DelegationError(`Target agent ${id} not found`, 'target_not_found');
    if (t !== tenantId) {
      await insertAuditLog(null, tenantId, {
        internalAgentId: parentAgentId, action: 'delegation.cross_tenant_blocked',
        inputArgs: { targetAgentId: id, targetTenant: t },
        outputSummary: `Blocked delegation to ${id} in tenant ${t}`, outcome: 'gated',
        triggeredBy: `agent:${parentAgentId}`,
      });
      delegation_cross_tenant_blocked_total.inc({ tenant_id: tenantId });
      throw new DelegationError(`Cross-tenant delegation blocked: ${id}`, 'cross_tenant');
    }
  }
}
