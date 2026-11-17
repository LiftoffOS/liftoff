// Debug router — health + simulate endpoints for governance evaluation.
//
// Mounted at /api/governance in server.ts (after verifyServiceAuth).
// These endpoints are service-token-gated — not exposed to end users,
// only to CI jobs, the adversarial eval runner, and operator scripts.
//
// Routes:
//   GET  /tenant/:tenantId/health    — cache state, pending count, rate limit, last audit
//   POST /tenant/:tenantId/simulate  — dry-run a checkHitlGate call with optional oversight override

import { Router } from 'express';
import { pool } from '../infrastructure/database.js';
import { hitlEnforcementService } from '../hitl-enforcement/service.js';
import { getLastAuditEntry } from '../audit/service.js';

export const debugRouter = Router();

const AUTONOMOUS_HOURLY_LIMIT = 1000;

// ── Health ──────────────────────────────────────────────────────────────────

debugRouter.get('/tenant/:tenantId/health', async (req, res) => {
  const { tenantId } = req.params;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

  try {
    // Fetch oversight settings, pending count, recent op count, last audit
    // entry, and raw cache metadata (synced_at, entity_version) in parallel.
    // getOversightSettings() does NOT return synced_at / entity_version, so
    // we need a separate raw pool query for those columns.
    const [oversight, pendingCount, recentOps, lastAudit, cacheRow] = await Promise.all([
      hitlEnforcementService.getOversightSettings(tenantId),
      hitlEnforcementService.getPendingApprovalCount(tenantId),
      hitlEnforcementService.getRecentOperationCount(tenantId, '1h'),
      getLastAuditEntry(tenantId),
      pool.query(
        `SELECT synced_at, entity_version FROM tenant_oversight_cache WHERE tenant_id = $1`,
        [tenantId],
      ),
    ]);

    const cacheMeta = cacheRow.rows[0] ?? null;
    const hitlLevel = hitlEnforcementService.getDefaultHitlLevel(
      oversight?.autonomy ?? 'balanced',
    );
    const cacheAgeSeconds = cacheMeta?.synced_at
      ? Math.floor(
          (Date.now() - new Date(cacheMeta.synced_at as string).getTime()) / 1000,
        )
      : null;

    return res.json({
      hitlLevel,
      oversightSettings: oversight,
      cacheAgeSeconds,
      entityVersion: cacheMeta?.entity_version ?? null,
      pendingApprovals: pendingCount,
      rateLimit: { used: recentOps, limit: AUTONOMOUS_HOURLY_LIMIT, windowHours: 1 },
      lastAuditEntry: lastAudit,
    });
  } catch (err) {
    console.error('debug-health-error', { tenantId, error: (err as Error).message, stack: (err as Error).stack });
    return res.status(500).json({ error: (err as Error).message });
  }
});

// ── Simulate ────────────────────────────────────────────────────────────────

debugRouter.post('/tenant/:tenantId/simulate', async (req, res) => {
  const { tenantId } = req.params;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

  const { toolCalls, tools, oversightOverride, trustLevel } = req.body as {
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    tools: Array<{ name: string; description: string; categories?: string[]; effect?: 'read' | 'write' | 'spawn' }>;
    oversightOverride?: {
      autonomy?: 'controlled' | 'balanced' | 'autonomous';
      escalation?: 'exceptions' | 'important' | 'sensitive';
      sensitiveWork?: Record<string, boolean>;
    };
    // Content trust of the simulated run — set 'untrusted_inbound' to preview the
    // external-content write gate (which keys on it plus per-tool effect above).
    trustLevel?: 'trusted' | 'untrusted_inbound';
  };

  if (!Array.isArray(toolCalls) || !Array.isArray(tools)) {
    return res.status(400).json({ error: 'toolCalls and tools arrays required' });
  }

  try {
    const liveOversight = await hitlEnforcementService.getOversightSettings(tenantId);

    // Merge oversightOverride on top of live settings — allows testing specific
    // configurations without mutating production state.
    const effectiveOversight = oversightOverride
      ? {
          tenantId,
          autonomy: oversightOverride.autonomy ?? liveOversight?.autonomy ?? 'balanced',
          escalation:
            oversightOverride.escalation ?? liveOversight?.escalation ?? 'important',
          sensitiveWork: (oversightOverride.sensitiveWork as {
            customerCommunication: boolean;
            financialActions: boolean;
            dataChanges: boolean;
            externalPublishing: boolean;
            hiringDecisions: boolean;
            mergeToMain: boolean;
          }) ?? liveOversight?.sensitiveWork ?? {
            customerCommunication: false,
            financialActions: false,
            dataChanges: false,
            externalPublishing: false,
            hiringDecisions: false,
            mergeToMain: false,
          },
          communication: liveOversight?.communication ?? 'review',
        }
      : liveOversight ?? undefined;

    const hitlLevel = hitlEnforcementService.getDefaultHitlLevel(
      effectiveOversight?.autonomy ?? 'balanced',
    );

    // dryRun: true — suppresses insertAuditLog() calls at levels 4 and 5
    const result = await hitlEnforcementService.checkHitlGate(
      toolCalls,
      effectiveOversight,
      hitlLevel,
      tools,
      tenantId,
      { dryRun: true, trustLevel },
    );

    // Fetch cache metadata separately (synced_at not in OversightSettings type)
    const cacheRow = await pool.query(
      `SELECT synced_at FROM tenant_oversight_cache WHERE tenant_id = $1`,
      [tenantId],
    );
    const cacheAgeSeconds = cacheRow.rows[0]?.synced_at
      ? Math.floor(
          (Date.now() -
            new Date(cacheRow.rows[0].synced_at as string).getTime()) /
            1000,
        )
      : null;

    return res.json({
      decision: result.shouldGate ? 'gated' : 'allowed',
      reason: result.reason ?? null,
      matchedCategory: result.matchedCategory ?? null,
      hitlLevel,
      oversightSettings: effectiveOversight,
      oversightSource: oversightOverride ? 'override' : 'cache',
      cacheAgeSeconds,
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});
