// Forward task ledger — the agent's standing worklist (plan §4.9 / Part B).
//
// Keyed (tenant_id, agent_id) — the agent's OWN list, persisting across all its
// triggers (NOT thread-keyed; threads are fresh per trigger). Agent-authored via
// the `task_ledger_write` tool; the open items are injected into the system prompt
// at invocation start (only when non-empty), so a fresh trigger days later sees
// what remains.

import { getPoolForService } from '../../infrastructure/database';
import { logger } from '../../infrastructure/logging';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'abandoned';

export interface TaskLedgerItem {
  seq: number;
  text: string;
  status: TaskStatus;
  note?: string;
}

function pool() {
  return getPoolForService('default');
}

/** Upsert ordered items by (tenant, agent, seq). Partial updates are fine — only
 *  the seqs present in `items` are touched; others remain. */
export async function writeTaskLedger(input: {
  tenantId: string;
  agentId: string;
  items: TaskLedgerItem[];
}): Promise<void> {
  if (input.items.length === 0) return;
  const pg = pool();
  for (const it of input.items) {
    await pg.query(
      `INSERT INTO agent_task_ledger (tenant_id, agent_id, seq, text, status, note)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, agent_id, seq) DO UPDATE SET
         text = EXCLUDED.text,
         status = EXCLUDED.status,
         note = EXCLUDED.note,
         updated_at = NOW()`,
      [input.tenantId, input.agentId, it.seq, it.text, it.status, it.note ?? null],
    );
  }
}

/** Open (pending / in_progress) items for an agent, ordered by seq. */
export async function getOpenTaskLedger(
  tenantId: string,
  agentId: string,
): Promise<TaskLedgerItem[]> {
  try {
    const res = await pool().query<{ seq: number; text: string; status: TaskStatus; note: string | null }>(
      `SELECT seq, text, status, note FROM agent_task_ledger
       WHERE tenant_id = $1::uuid AND agent_id = $2::uuid
         AND status IN ('pending', 'in_progress')
       ORDER BY seq ASC`,
      [tenantId, agentId],
    );
    return res.rows.map((r) => ({ seq: r.seq, text: r.text, status: r.status, ...(r.note ? { note: r.note } : {}) }));
  } catch (err) {
    logger.warn({ err: (err as Error).message, agentId }, 'getOpenTaskLedger failed (non-fatal)');
    return [];
  }
}

/** Render the open ledger as a markdown checklist block for the system prompt.
 *  Returns '' when there are no open items (so the block is omitted entirely). */
export function renderTaskLedgerBlock(items: TaskLedgerItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map(
    (it) => `- [${it.status === 'in_progress' ? '~' : ' '}] (#${it.seq}) ${it.text}${it.note ? `  — ${it.note}` : ''}`,
  );
  return (
    `\n\n## Task Ledger (your standing worklist — carried over from earlier runs)\n`
    + lines.join('\n')
    + `\n\nResume from the first open item. Update it with task_ledger_write as you `
    + `make progress (mark items in_progress / done). Do not redo done items.`
  );
}
