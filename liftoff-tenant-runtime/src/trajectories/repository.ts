// Part 6 §F — index-table writes for agent_trajectories.
//
// gcs_path is NULL when the quality filter skipped the GCS write (no
// reasoning blocks), so consumers can distinguish "not written, but
// accounted for" from "missing".

import { getPoolForService } from '../infrastructure/database';
import type { ExecutionEngineId, NestedSpecialistEngineId } from '../agent-execution/adapter/types';

export interface TrajectoryIndexRow {
  tenantId: string;
  agentId: string;
  invocationId: string;
  parentInvocationId?: string;
  nestedKind?: 'code_session';
  gcsPath: string | null;
  bytes: number;
  turnCount: number;
  completed: boolean;
  provider: string;
  model: string;
  hasReasoning: boolean;
  schemaVersion: string;
  /** Concrete outer-agent engine (migration 322,). NULL for nested
   * code_session rows (they carry nestedEngine) and pre-322 rows. */
  executionEngine?: ExecutionEngineId | null;
  /** Nested code_session specialist engine (migration 322). NULL for top-level rows. */
  nestedEngine?: NestedSpecialistEngineId | null;
}

/** One index row per invocation. A run that paused and was resumed writes
 *  twice under the same id — the paused half at the pause, the continuation
 *  when the work finishes — and the second write is the one that describes the
 *  whole conversation, so it replaces the first rather than being dropped. */
export async function insertTrajectoryIndex(row: TrajectoryIndexRow): Promise<void> {
  const pool = getPoolForService('default');
  await pool.query(
    `INSERT INTO agent_trajectories (
       tenant_id, agent_id, invocation_id, parent_invocation_id, nested_kind,
       gcs_path, bytes, turn_count, completed, provider, model, has_reasoning, schema_version,
       execution_engine, nested_engine
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (tenant_id, invocation_id) DO UPDATE SET
       gcs_path = EXCLUDED.gcs_path,
       bytes = EXCLUDED.bytes,
       turn_count = EXCLUDED.turn_count,
       completed = EXCLUDED.completed,
       has_reasoning = EXCLUDED.has_reasoning,
       schema_version = EXCLUDED.schema_version`,
    [
      row.tenantId,
      row.agentId,
      row.invocationId,
      row.parentInvocationId ?? null,
      row.nestedKind ?? null,
      row.gcsPath,
      row.bytes,
      row.turnCount,
      row.completed,
      row.provider,
      row.model,
      row.hasReasoning,
      row.schemaVersion,
      row.executionEngine ?? null,
      row.nestedEngine ?? null,
    ],
  );
}
