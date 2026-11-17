import { randomUUID } from 'crypto';
import { getPoolForService } from '../../infrastructure/database';
import { logger } from '../../infrastructure/logging';
import { armStallWatch } from '../../scheduling/stall-watch';
import {
  AgentRunState,
  AgentRunItemInput,
  AGENT_RUN_STATE_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
} from './types';

export class AgentRunStateService {
  private pool() {
    return getPoolForService('default');
  }

  async create(input: Omit<AgentRunState, '$schemaVersion' | 'createdAt' | 'updatedAt'>): Promise<AgentRunState> {
    const pool = this.pool();
    const state: AgentRunState = {
      ...input,
      $schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await pool.query(
      `INSERT INTO agent_run_states (invocation_id, tenant_id, agent_id, schema_version, state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (invocation_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [state.invocationId, state.tenantId, state.agentId, AGENT_RUN_STATE_SCHEMA_VERSION, JSON.stringify(state)],
    );
    return state;
  }

  async load(invocationId: string): Promise<AgentRunState | null> {
    const pool = this.pool();
    const result = await pool.query<{ state: unknown }>(
      `SELECT state FROM agent_run_states WHERE invocation_id = $1`,
      [invocationId],
    );
    if (result.rows.length === 0) return null;
    const state = this.fromJson(JSON.stringify(result.rows[0].state));
    // Fail closed on an unsupported schema version: after the one-time 1.0→1.1
    // upgrade migration the read path supports 1.1 only. Rather than silently
    // coerce an unknown/legacy shape into 1.1 (and resume on mis-structured state),
    // treat the row as absent — callers already null-check load(), so a resume
    // falls back to the certified snapshot path and status surfaces render "no state".
    if (!SUPPORTED_SCHEMA_VERSIONS.has(state.$schemaVersion)) {
      logger.warn(
        { invocationId, schemaVersion: state.$schemaVersion, event: 'run_state_unsupported_schema_version' },
        'agent_run_states row is not a supported schema version; treating as absent (no silent coercion)',
      );
      return null;
    }
    return state;
  }

  async save(state: AgentRunState): Promise<void> {
    const pool = this.pool();
    const updated = { ...state, updatedAt: new Date().toISOString() };
    await pool.query(
      `UPDATE agent_run_states SET state = $2, updated_at = now() WHERE invocation_id = $1`,
      [state.invocationId, JSON.stringify(updated)],
    );
  }

  async appendItem(invocationId: string, item: AgentRunItemInput): Promise<void> {
    const pool = this.pool();
    // Atomic append via jsonb concat on the items array.
    //
    // `id` and `parentId` are resolved INSIDE this statement rather than by the
    // caller. `parentId` is the id of the item currently last in the array, and
    // reading that in JS first would be a read-modify-write: two concurrent
    // appends would both observe the same last item and both claim it as parent,
    // producing a fork in what is supposed to be a linear chain. Postgres
    // evaluates the subexpression against the row it is already locking, so the
    // parent link is always the item this one genuinely followed.
    //
    // `-> -1` is the last element, and `->>'id'` yields SQL NULL on an empty
    // array — which is exactly the value the first item of a run needs.
    //
    // C5: the same write carries a memory sample. This is the run's heartbeat —
    // it is what `updated_at` means to the stalled-run reconciler — so sampling
    // here costs nothing extra and gives a stall a shape. A run that dies with
    // RSS climbing across its last heartbeats was killed for memory; one that
    // stalls flat was not.
    await pool.query(
      `UPDATE agent_run_states
       SET state = jsonb_set(
             state,
             '{items}',
             COALESCE(state->'items', '[]'::jsonb) || jsonb_build_array(
               $2::jsonb
                 || jsonb_build_object('id', $4::text)
                 || jsonb_build_object('parentId', COALESCE(state->'items'->-1->>'id', NULL))
             ),
             false),
           last_rss_bytes = $3,
           updated_at = now()
       WHERE invocation_id = $1`,
      [invocationId, JSON.stringify(item), sampleRssBytes(), randomUUID()],
    );
    // A heartbeat pushes the run's stall check forward (one Cloud Tasks call
    // per bucket per process; see maintenance-tasks.ts).
    armStallWatch();
  }

  /** Persist the upstream SDK session/thread id the engine exposed
   * (from the adapter's `session_started` event) onto providerState. Atomic
   * jsonb merge so it coexists with the engineId written at create() without a
   * read-modify-write race. No-op when the engine surfaces no id. */
  async setUpstreamSession(invocationId: string, ids: { sessionId?: string; threadId?: string }): Promise<void> {
    const patch: Record<string, string> = {};
    if (ids.sessionId) patch.upstreamSessionId = ids.sessionId;
    if (ids.threadId) patch.upstreamThreadId = ids.threadId;
    if (Object.keys(patch).length === 0) return;
    const pool = this.pool();
    await pool.query(
      `UPDATE agent_run_states
         SET state = jsonb_set(state, '{providerState}', COALESCE(state->'providerState', '{}'::jsonb) || $2::jsonb, false),
             updated_at = now()
       WHERE invocation_id = $1`,
      [invocationId, JSON.stringify(patch)],
    );
  }

  toJson(state: AgentRunState): string {
    return JSON.stringify(state);
  }

  /** Pure parse. The schema-version gate lives in load() (fail-closed on an
   *  unsupported version); persisted 1.1 rows already carry the engine-aware
   *  providerState, so no read-time translation is needed. */
  fromJson(json: string): AgentRunState {
    return JSON.parse(json) as AgentRunState;
  }
}

/** Resident set size right now, or null when the runtime will not report it.
 *  Never throws: a heartbeat must not fail over a diagnostic. */
function sampleRssBytes(): number | null {
  try {
    const rss = process.memoryUsage().rss;
    return Number.isFinite(rss) ? rss : null;
  } catch {
    return null;
  }
}

export const agentRunStateService = new AgentRunStateService();
