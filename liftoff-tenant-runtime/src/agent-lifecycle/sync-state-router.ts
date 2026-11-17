// Sync-state router (plan §6.1, §6.3).
// Endpoints called by platform-backend's reconciler to detect drift between
// PB's internal_agents table and the runtime's mapping/instruction state.
//
// All routes require OIDC service auth: PB's service account mints a token with
// audience == the agent-service Cloud Run URL.

import { createHash } from 'crypto';
import { Router, Request, Response } from 'express';
import { requireServiceAuth } from '../security/service-auth';
import { getPoolForService } from '../infrastructure/database';
import { getTenantRuntimeUrl } from '../infrastructure/runtime-env';
import { getJobName } from '../scheduling/job-name';
import { logger } from '../infrastructure/logging';

export const syncStateRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const oidcGuard = () =>
  requireServiceAuth({
    acceptOidc: true,
    oidcAudience: () => getTenantRuntimeUrl(),
    allowedOidcEmails: () => {
      const email = process.env.PLATFORM_BACKEND_SA_EMAIL ?? '';
      return email ? [email] : [];
    },
  });

// Canonical key-sorted JSON serialization for stable cross-service hashing.
// PB and TR both compute sha256(canonicalize(field)); JSONB round-tripping
// loses key insertion order, so any non-canonical serialization yields hash
// mismatches even when the data is semantically identical. Recursive over
// nested objects and arrays. Null inputs collapse to the literal string
// `"null"` so a missing field hashes identically on both sides.
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') +
    '}'
  );
}

function sha256OfCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

// GET /internal/agents/sync-state?tenantId=X&internalAgentId=Y
// Returns the runtime's full view of one agent so PB's reconciler can detect
// six drift modes: missing_create, missing_instruction, stale_update,
// missed_delete, orphan_in_runtime, and (new) stale_content where the version
// is current but a behavior-affecting field's stored value diverged from PB
// (e.g. the v22 trigger_config drop before commit ec5fcc5 deployed).
//
// Content hashes are sha256 of canonical key-sorted JSON so the reconciler
// can compare them against PB-side hashes regardless of JSONB key ordering.
// Hash of a NULL/empty column is the hash of the literal string `"null"`.
syncStateRouter.get('/sync-state', oidcGuard(), async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined;
  const internalAgentId = req.query.internalAgentId as string | undefined;
  if (!tenantId || !internalAgentId) {
    return res.status(400).json({ error: 'tenantId and internalAgentId required' });
  }

  const pool = getPoolForService('scheduled-execution');
  try {
    const r = await pool.query<{
      agent_id: string;
      lifecycle: string;
      cached_entity_version: number | null;
      cached_status: string | null;
      has_active_instruction: boolean;
      trigger_config: Record<string, unknown> | null;
      instructions_md: string | null;
      compiled_system_prompt: string | null;
      compiled_user_instructions: string | null;
      compiled_capability_tier: string | null;
      compiled_result_rules: unknown;
    }>(
      `SELECT
         m.agent_id,
         a.lifecycle,
         a.trigger_config,
         a.instructions_md,
         cia.entity_version       AS cached_entity_version,
         cia.status               AS cached_status,
         EXISTS (
           SELECT 1 FROM compiled_instructions ci
           WHERE ci.tenant_id = m.tenant_id
             AND ci.agent_id = m.agent_id
             AND ci.status = 'active'
         )                        AS has_active_instruction,
         (
           SELECT ci.system_prompt FROM compiled_instructions ci
           WHERE ci.tenant_id = m.tenant_id
             AND ci.agent_id = m.agent_id
             AND ci.status = 'active'
           ORDER BY ci.version DESC LIMIT 1
         )                        AS compiled_system_prompt,
         (
           SELECT ci.user_instructions FROM compiled_instructions ci
           WHERE ci.tenant_id = m.tenant_id
             AND ci.agent_id = m.agent_id
             AND ci.status = 'active'
           ORDER BY ci.version DESC LIMIT 1
         )                        AS compiled_user_instructions,
         (
           SELECT ci.capability_tier FROM compiled_instructions ci
           WHERE ci.tenant_id = m.tenant_id
             AND ci.agent_id = m.agent_id
             AND ci.status = 'active'
           ORDER BY ci.version DESC LIMIT 1
         )                        AS compiled_capability_tier,
         (
           SELECT ci.result_rules FROM compiled_instructions ci
           WHERE ci.tenant_id = m.tenant_id
             AND ci.agent_id = m.agent_id
             AND ci.status = 'active'
           ORDER BY ci.version DESC LIMIT 1
         )                        AS compiled_result_rules
       FROM internal_agent_runtime_mapping m
       JOIN agents a              ON a.id = m.agent_id
       LEFT JOIN cached_internal_agents cia
         ON cia.internal_agent_id = m.internal_agent_id
        AND cia.tenant_id = m.tenant_id
       WHERE m.tenant_id = $1 AND m.internal_agent_id = $2`,
      [tenantId, internalAgentId],
    );

    if (r.rows.length === 0) {
      return res.json({ hasMapping: false });
    }
    const row = r.rows[0];
    return res.json({
      hasMapping: true,
      runtimeAgentId: row.agent_id,
      lifecycle: row.lifecycle,
      hasActiveInstruction: row.has_active_instruction,
      cachedEntityVersion: row.cached_entity_version,
      cachedStatus: row.cached_status,
      // Field-level content hashes for stale_content drift detection.
      // PB recomputes each hash from its source-of-truth and compares;
      // mismatches mean the runtime applied a stale event whose payload
      // got dropped by code that has since been fixed (so the version gate
      // is satisfied but the persisted state still drifts).
      triggerConfigHash: sha256OfCanonical(row.trigger_config),
      instructionsHash: sha256OfCanonical({
        systemPrompt: row.compiled_system_prompt,
        userInstructions: row.compiled_user_instructions,
        instructionsMd: row.instructions_md,
      }),
      capabilityTier: row.compiled_capability_tier,
      // Hashed rather than sent raw, unlike capabilityTier: this is an array,
      // and a raw comparison would have to agree on ordering and key order
      // across two services. Its own field rather than folded into
      // instructionsHash — that shape is already agreed with PB byte for byte,
      // and changing it would make every agent in the estate read as drifted on
      // the first tick after deploy.
      //
      // A missing column reads as an empty policy here, which matches what the
      // compiler writes for an agent distilled before result rules existed.
      resultRulesHash: sha256OfCanonical(row.compiled_result_rules ?? []),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, tenantId, internalAgentId }, 'sync-state query failed');
    return res.status(500).json({ error: 'sync-state query failed' });
  }
});

// GET /internal/agents/list-mappings?tenantId=X
// Returns every (internalAgentId, runtimeAgentId) pair in the tenant. Used by
// PB's reconciler to find orphans (mappings without a PB row), and by
// scripts/backfill-attribution-agent-ids.ts to re-key historical cost rows.
//
// `name` / `role` / `lifecycle` are additive: the pairs alone are opaque
// uuids, which is useless to a human trying to answer "which of these is Code
// Reviewer?". Existing consumers read fields by name and are unaffected.
syncStateRouter.get('/list-mappings', oidcGuard(), async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

  const pool = getPoolForService('scheduled-execution');
  try {
    const r = await pool.query<{
      internal_agent_id: string;
      agent_id: string;
      name: string | null;
      role: string | null;
      lifecycle: string | null;
    }>(
      `SELECT m.internal_agent_id, m.agent_id, a.name, a.role, a.lifecycle
       FROM internal_agent_runtime_mapping m
       LEFT JOIN agents a ON a.id = m.agent_id
       WHERE m.tenant_id = $1
       ORDER BY a.name NULLS LAST, m.agent_id`,
      [tenantId],
    );
    res.json(r.rows.map((row) => ({
      internalAgentId: row.internal_agent_id,
      runtimeAgentId: row.agent_id,
      name: row.name,
      role: row.role,
      lifecycle: row.lifecycle,
    })));
  } catch (err) {
    logger.error({ err: (err as Error).message, tenantId }, 'list-mappings query failed');
    return res.status(500).json({ error: 'list-mappings query failed' });
  }
});

// GET /internal/agents/resolve?tenantId=X&id=<either-id-space>
//
// Operator escape hatch for the id-space trap (INV-TR-010). Takes an agent uuid
// from EITHER space — a runtime id seen in a log line, an invocation row, or a
// Cloud Scheduler job name; or a control-plane id from the dashboard URL — and
// returns both ids, the agent's name, and the scheduler job name (which embeds
// the runtime id and is otherwise not derivable from anything the UI shows).
//
// Answers, in one call, the questions an id-space investigation keeps asking:
// "which agent is 577a520f?", "what is this scheduler job?", "does this id
// even exist?".
syncStateRouter.get('/resolve', oidcGuard(), async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined;
  const id = req.query.id as string | undefined;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
  if (!id) return res.status(400).json({ error: 'id required' });
  // Both columns are uuid, so a malformed value would make Postgres raise
  // 22P02 and this endpoint answer a truncated id with an opaque 500 — exactly
  // the dead end it exists to remove. Reject it clearly instead.
  if (!UUID_RE.test(tenantId)) return res.status(400).json({ error: 'tenantId must be a uuid' });
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id must be a full uuid' });

  const pool = getPoolForService('scheduled-execution');
  try {
    // Probe both columns in one pass; `matchedOn` tells the caller which space
    // they handed us, which is itself usually the answer they needed.
    const r = await pool.query<{
      internal_agent_id: string;
      agent_id: string;
      name: string | null;
      role: string | null;
      lifecycle: string | null;
      matched_on: string;
    }>(
      `SELECT m.internal_agent_id, m.agent_id, a.name, a.role, a.lifecycle,
              CASE WHEN m.agent_id = $2 THEN 'runtime' ELSE 'internal' END AS matched_on
       FROM internal_agent_runtime_mapping m
       LEFT JOIN agents a ON a.id = m.agent_id
       WHERE m.tenant_id = $1 AND (m.agent_id = $2 OR m.internal_agent_id = $2)
       LIMIT 1`,
      [tenantId, id],
    );

    if (r.rows.length === 0) {
      // Distinguish "no mapping" from "not an agent id at all": an agents row
      // with no mapping is a real (if broken) state the reconciler self-heals.
      const orphan = await pool.query<{ id: string; name: string | null; lifecycle: string | null }>(
        `SELECT id, name, lifecycle FROM agents WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      if (orphan.rows.length > 0) {
        return res.json({
          found: true,
          matchedOn: 'runtime',
          internalAgentId: null,
          runtimeAgentId: orphan.rows[0].id,
          name: orphan.rows[0].name,
          role: null,
          lifecycle: orphan.rows[0].lifecycle,
          schedulerJobName: getJobName(tenantId, orphan.rows[0].id),
          note: 'agents row exists but has no internal_agent_runtime_mapping — the canonical reconciler self-heals this within ~5 minutes',
        });
      }
      return res.json({ found: false });
    }

    const row = r.rows[0];
    return res.json({
      found: true,
      matchedOn: row.matched_on,
      internalAgentId: row.internal_agent_id,
      runtimeAgentId: row.agent_id,
      name: row.name,
      role: row.role,
      lifecycle: row.lifecycle,
      schedulerJobName: getJobName(tenantId, row.agent_id),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, tenantId, id }, 'resolve query failed');
    return res.status(500).json({ error: 'resolve query failed' });
  }
});
