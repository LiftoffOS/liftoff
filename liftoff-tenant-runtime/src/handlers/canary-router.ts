// WS-10.2 — canary read-back endpoint.
//
// GET /canary/latest-invocation returns the most recent `invocations` row for
// the canary tenant, reshaped into exactly what scripts/canary-assertions.ts
// consumes:
//
//   { outcome: string, tool_calls: [{ name, result: { success, error, output } }] }
//
// The assertion runner then checks: outcome === 'success', every tool call
// result.success is truthy, and no result JSON contains the historical
// "Standard tool … executed" stub-fallback string.
//
// HARD GUARD: this endpoint is only mounted-live when ENVIRONMENT === 'canary'
// (the ephemeral PR-canary Cloud Run service). In dev/prod it returns 404 so
// invocation internals are never exposed.

import { Router, Request, Response } from 'express';
import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

const router = Router();

interface PersistedToolCall {
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string | null;
}

router.get('/latest-invocation', async (req: Request, res: Response) => {
  if (process.env.ENVIRONMENT !== 'canary') {
    return res.status(404).json({ error: 'not found' });
  }

  // The canary DB is single-tenant; the tenant UUID is injected at deploy time.
  const canaryTenantId = process.env.CANARY_TENANT_ID;
  if (!canaryTenantId) {
    return res.status(500).json({ error: 'CANARY_TENANT_ID not set' });
  }

  // Scope to this run's agent when one is injected.
  //
  // The tenant is shared across canary runs and the agent is per-run, so "the
  // most recent invocation for this tenant" is whichever canary finished last —
  // not necessarily the one asking. Two concurrent canaries would otherwise
  // assert against each other's results, and a pull request could pass or fail
  // on a run it never triggered.
  //
  // Optional so an older deployment that predates CANARY_AGENT_ID keeps its
  // previous behaviour rather than 500ing.
  const canaryAgentId = process.env.CANARY_AGENT_ID;

  try {
    const row = await withTenantScope(canaryTenantId, async (client) => {
      const result = await client.query(
        `SELECT id, outcome, tool_calls, error_message, started_at
           FROM invocations
          WHERE tenant_id = $1
            AND ($2::uuid IS NULL OR agent_id = $2::uuid)
          ORDER BY started_at DESC
          LIMIT 1`,
        [canaryTenantId, canaryAgentId ?? null],
      );
      return result.rows[0];
    });

    if (!row) {
      return res.status(404).json({ error: 'no canary invocation found' });
    }

    const rawToolCalls: PersistedToolCall[] = Array.isArray(row.tool_calls)
      ? row.tool_calls
      : typeof row.tool_calls === 'string'
        ? JSON.parse(row.tool_calls || '[]')
        : [];

    const tool_calls = rawToolCalls.map((tc) => ({
      name: tc.name ?? 'unknown',
      // Keep the tool's real output inside `result` so the assertion's
      // "Standard tool … executed" stub-fallback scan actually inspects what
      // the tool returned. success is true only when the tool did not error.
      result: {
        success: !tc.error,
        error: tc.error ?? undefined,
        output: tc.output,
      },
    }));

    return res.status(200).json({
      invocation_id: row.id,
      outcome: row.outcome,
      error_message: row.error_message ?? null,
      tool_calls,
    });
  } catch (err) {
    logger.error('canary latest-invocation failed', { error: (err as Error).message });
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
