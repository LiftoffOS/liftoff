// Action-trust decisions repository.

import type { PoolClient } from 'pg';
import { withTenantScope } from '../infrastructure/database';
import type { DecisionRow } from './types';

/** Single multi-VALUES insert, idempotent on (tenant_id, source_key). Runs under the
 *  caller's tenant scope (the router wraps withTenantScope and passes the client). */
export async function insertDecisions(client: PoolClient, rows: DecisionRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach((r, i) => {
    const b = i * 9;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
    params.push(
      r.tenantId, r.agentId, r.actionClass, r.gateReason, r.decision,
      r.decidedBy, r.decidedAt, r.source, r.sourceKey,
    );
  });
  const res = await client.query(
    `INSERT INTO action_trust_decisions
       (tenant_id, agent_id, action_class, gate_reason, decision, decided_by, decided_at, source, source_key)
     VALUES ${values.join(',')}
     ON CONFLICT (tenant_id, source_key) DO NOTHING`,
    params,
  );
  return res.rowCount ?? 0;
}

export interface TrustCounts {
  runs: number;
  passRate: number;
  distinctApprovers: number;
}

/** Decisions-only trust math over the trailing windowDays. */
export async function computeTrust(
  tenantId: string,
  agentId: string,
  actionClass: string,
  windowDays: number,
): Promise<TrustCounts> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ runs: string; approved: string; approvers: string }>(
      `SELECT count(*) AS runs,
              count(*) FILTER (WHERE decision = 'approved') AS approved,
              -- distinct humans who APPROVED (not merely decided) — the "≥2 approvers vouched"
              -- signal must not be satisfied by an approver + a rejecter being two people.
              count(DISTINCT decided_by) FILTER (WHERE decision = 'approved') AS approvers
         FROM action_trust_decisions
        WHERE tenant_id = $1 AND agent_id = $2 AND action_class = $3
          AND decided_at >= now() - ($4 || ' days')::interval`,
      [tenantId, agentId, actionClass, windowDays],
    );
    const row = res.rows[0];
    const runs = Number(row?.runs ?? 0);
    const approved = Number(row?.approved ?? 0);
    return {
      runs,
      passRate: runs > 0 ? approved / runs : 0,
      distinctApprovers: Number(row?.approvers ?? 0),
    };
  });
}

/** Distinct action classes observed for a (tenant, agent, gate_reason) in the window —
 *  consumed by the advisor's all-classes-auto rule. */
export async function listActionClassesForReason(
  tenantId: string,
  agentId: string,
  gateReason: string,
  windowDays: number,
): Promise<string[]> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ action_class: string }>(
      `SELECT DISTINCT action_class
         FROM action_trust_decisions
        WHERE tenant_id = $1 AND agent_id = $2 AND gate_reason = $3
          AND decided_at >= now() - ($4 || ' days')::interval`,
      [tenantId, agentId, gateReason, windowDays],
    );
    return res.rows.map((r) => r.action_class);
  });
}
