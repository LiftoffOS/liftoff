// The thread an Insights Manager or Chief AI Officer conversation uses with
// each colleague it brings in (migration 495).
//
// Liftoff keeps the same record in liftoff_thread_delegations; this is the
// record for the two surfaces that can now hand a turn over as well. Same
// two operations, same rule: the first pairing wins, and a race carries on in
// the winner's thread rather than in the orphan it created.
//
// The table is FORCE-RLS (INV-PB-001), so every read and write is tenant-scoped.

import { withTenantScope } from '../infrastructure/database';
import type { DelegationTargetKind } from '../liftoff/delegation-targets';

/** Which conversation table `thread_id` names: insights_chat_threads, or the
 *  workforce service's team_plan_threads for the Chief AI Officer. */
export type DelegatingSurface = 'insights' | 'caio';

export interface AssistantThreadPairing {
  targetKind: DelegationTargetKind;
  targetId: string | null;
  delegateThreadId: string;
}

/** The paired thread for one colleague of one conversation, if a hand-over
 *  has opened one. `targetId` is a team's id, and null for a platform
 *  assistant: `IS NOT DISTINCT FROM` is what lets one query serve both,
 *  since plain equality never matches a NULL. */
export async function getAssistantThreadDelegation(
  tenantId: string,
  surface: DelegatingSurface,
  threadId: string,
  targetKind: AssistantThreadPairing['targetKind'],
  targetId: string | null,
): Promise<AssistantThreadPairing | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT target_kind, target_id, delegate_thread_id
       FROM assistant_thread_delegations
      WHERE tenant_id = $1 AND surface = $2 AND thread_id = $3
        AND target_kind = $4
        AND target_id IS NOT DISTINCT FROM $5`,
    [tenantId, surface, threadId, targetKind, targetId],
  ));
  const row = result.rows[0];
  if (!row) return null;
  return {
    targetKind: row.target_kind as AssistantThreadPairing['targetKind'],
    targetId: (row.target_id as string | null) ?? null,
    delegateThreadId: row.delegate_thread_id as string,
  };
}

/** Record the paired thread, returning whichever pairing now stands: the one
 *  just written, or the one another turn wrote first. The two partial unique
 *  indexes from migration 495 are what the conflict fires on, which is why no
 *  conflict target is named. */
export async function pairAssistantThreadDelegation(input: {
  tenantId: string;
  surface: DelegatingSurface;
  threadId: string;
  targetKind: AssistantThreadPairing['targetKind'];
  targetId: string | null;
  delegateThreadId: string;
}): Promise<string> {
  const inserted = await withTenantScope(input.tenantId, (client) => client.query(
    `INSERT INTO assistant_thread_delegations
       (tenant_id, surface, thread_id, target_kind, target_id, delegate_thread_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING delegate_thread_id`,
    [input.tenantId, input.surface, input.threadId, input.targetKind, input.targetId, input.delegateThreadId],
  ));
  if (inserted.rows[0]) return inserted.rows[0].delegate_thread_id as string;

  const existing = await getAssistantThreadDelegation(
    input.tenantId, input.surface, input.threadId, input.targetKind, input.targetId,
  );
  if (!existing) {
    throw new Error('assistant_thread_delegations: pairing neither inserted nor found');
  }
  return existing.delegateThreadId;
}

/** The reverse lookup: which conversation a colleague's thread was brought in
 *  from. The source-conversation read resolves a Chief AI Officer thread this
 *  way, so a caller cannot name an arbitrary thread; only a pairing that
 *  exists under the caller's tenant answers. */
export async function getAssistantDelegationByDelegateThread(
  tenantId: string,
  surface: DelegatingSurface,
  targetKind: AssistantThreadPairing['targetKind'],
  delegateThreadId: string,
): Promise<{ threadId: string } | null> {
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT thread_id
       FROM assistant_thread_delegations
      WHERE tenant_id = $1 AND surface = $2 AND target_kind = $3 AND delegate_thread_id = $4`,
    [tenantId, surface, targetKind, delegateThreadId],
  ));
  const row = result.rows[0];
  return row ? { threadId: row.thread_id as string } : null;
}
