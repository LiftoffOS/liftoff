// Backfill Pinned Knowledge Job
//
// One-shot Cloud Run Job per Phase 4 of the knowledge-pin-retrieval-bias plan.
// Walks every internal_agent and:
//   1. Parses [[knowledge:id:title]] markers from responsibilities + additional_context.
//   2. Looks up each ID's connector_id and validates against the agent's bound
//      integrations.
//   3. Logs + skips orphan pins (missing item OR unbound connector).
//   4. Persists surviving IDs to pinned_knowledge_ids.
//   5. Strips the legacy "\n\n## Knowledge\n..." suffix from system_prompt
//      ONLY when its structure exactly matches what the now-deleted
//      buildKnowledgeSection() would have produced. Hand-edited sections
//      are left alone.
//
// Per-agent stats are written to pinned_knowledge_backfill_report so operators
// can audit which tenants had orphan-pin issues. Idempotent: re-running is a
// no-op (no markers → ## Knowledge already stripped → nothing to do).
//
// Auth: X-Service-Auth / PLATFORM_CALLBACK_TOKEN (same pattern as other jobs).

import crypto from 'crypto'
import { Router, type Request, type Response } from 'express'
import { log } from '../infrastructure/logging'
import { pool, withAdminScope } from '../infrastructure/database';
import * as knowledgeRepo from '../knowledge/repository'

export const backfillPinnedKnowledgeRouter = Router()

// RFC 4122 UUID regex. Markers in prose can carry any non-colon non-bracket
// string in their id slot, but findByIds (and downstream UUID[] writes) will
// throw "invalid input syntax for type uuid" on garbage. Filter at the parse
// boundary so a single malformed legacy marker can't fail an entire batch.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateServiceAuth(req: Request, res: Response): boolean {
  const serviceToken = req.headers['x-service-auth'] as string | undefined
  const expectedToken = process.env.PLATFORM_CALLBACK_TOKEN

  if (!expectedToken) {
    res.status(500).json({ error: 'Service authentication not configured' })
    return false
  }

  const isValid =
    serviceToken &&
    Buffer.byteLength(serviceToken) === Buffer.byteLength(expectedToken) &&
    crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expectedToken))

  if (!isValid) {
    res.status(401).json({ error: 'Invalid service authentication' })
    return false
  }
  return true
}

/**
 * Strips the legacy `\n\n## Knowledge\n...` suffix iff its lines correspond
 * 1:1 to what the (deleted) `buildKnowledgeSection` helper would have
 * produced for the parsed marker set. Any deviation (extra lines, reordered
 * lines, prose edits) means the operator hand-edited and we leave it alone.
 */
export function safeStripAutoKnowledgeSection(
  systemPrompt: string,
  parsedItems: Array<{ title: string; sourceUrl: string | null }>,
): string {
  const match = systemPrompt.match(/\n\n## Knowledge\n([\s\S]*)$/)
  if (!match) return systemPrompt
  const sectionBody = match[1]
  const expectedLines = parsedItems.map(k =>
    k.sourceUrl ? `- ${k.title}: ${k.sourceUrl}` : `- ${k.title}`,
  )
  const actualLines = sectionBody.trim().split('\n')
  if (actualLines.length !== expectedLines.length) return systemPrompt
  const allMatch = actualLines.every((line, i) => line === expectedLines[i])
  if (!allMatch) return systemPrompt
  return systemPrompt.slice(0, match.index)
}

interface AgentBackfillResult {
  agentId: string
  tenantId: string
  pinsBackfilled: number
  pinsDroppedInvalid: number
  systemPromptStripped: boolean
  invalidPinDetails: Array<{ id: string; reason: string }>
}

export async function runBackfillBatch(): Promise<{
  agentsProcessed: number
  pinsBackfilled: number
  pinsDroppedInvalid: number
  systemPromptsStripped: number
  systemPromptsLeftAlone: number
}> {
  const totals = {
    agentsProcessed: 0,
    pinsBackfilled: 0,
    pinsDroppedInvalid: 0,
    systemPromptsStripped: 0,
    systemPromptsLeftAlone: 0,
  }

  // Walk every non-deleted tenant agent. Done cross-tenant via admin scope so
  // a single batch covers every tenant in one pass. Excludes system agents
  // (is_system = TRUE / tenant_id IS NULL, migration 193) — those are
  // platform-owned (CAIO, HRBP) and:
  //   1. Don't carry [[knowledge:...]] markers (config-only, no prose pins).
  //   2. Can't reference tenant-scoped knowledge_items in the first place.
  //   3. Would fail the pinned_knowledge_backfill_report NOT NULL tenant_id
  //      constraint if we tried to record them.
  const cursor = await withAdminScope({ caller: 'backfill-pinned-knowledge', reason: 'cross-tenant backfill of pinned-knowledge on internal_agents' }, (client) => client.query(
    `SELECT id, tenant_id, responsibilities, additional_context, system_prompt,
            integrations, pinned_knowledge_ids
       FROM internal_agents
      WHERE deleted_at IS NULL
        AND tenant_id IS NOT NULL`,
  ))

  for (const row of cursor.rows) {
    const agentId = row.id as string
    const tenantId = row.tenant_id as string
    const responsibilities = (row.responsibilities as string | null) ?? ''
    const additionalContext = (row.additional_context as string | null) ?? ''
    const systemPrompt = (row.system_prompt as string | null) ?? ''
    const integrations = Array.isArray(row.integrations) ? row.integrations as Array<{ id?: string }> : []
    const existingPinnedIds = Array.isArray(row.pinned_knowledge_ids)
      ? row.pinned_knowledge_ids as string[]
      : []
    const boundConnectorIds = new Set(integrations.map(i => i.id).filter((x): x is string => !!x))

    const combined = [responsibilities, additionalContext].filter(Boolean).join('\n')
    const matches = [...combined.matchAll(/\[\[knowledge:([^:\]]+):[^\]]+\]\]/g)]
    const rawIds = [...new Set(matches.map(m => m[1]))]
    const malformed = rawIds.filter(id => !UUID_RE.test(id))
    const uniqueIds = rawIds.filter(id => UUID_RE.test(id))

    const backfillResult: AgentBackfillResult = {
      agentId,
      tenantId,
      pinsBackfilled: 0,
      pinsDroppedInvalid: malformed.length,
      systemPromptStripped: false,
      invalidPinDetails: malformed.map(id => ({ id, reason: 'malformed_uuid' })),
    }

    const surviving: string[] = []
    const parsedItemsForStrip: Array<{ title: string; sourceUrl: string | null }> = []

    if (uniqueIds.length > 0) {
      const items = await knowledgeRepo.findByIds(tenantId, uniqueIds)
      const found = new Map(items.map(i => [i.id, i]))
      for (const id of uniqueIds) {
        const item = found.get(id)
        if (!item) {
          // Item was deleted from knowledge_items. Legacy buildKnowledgeSection
          // would have skipped this too (findByIds returned nothing), so don't
          // include it in the strip-comparison shape either.
          backfillResult.pinsDroppedInvalid++
          backfillResult.invalidPinDetails.push({ id, reason: 'knowledge_item_deleted' })
          log.warn({ agentId, tenantId, pinId: id }, 'backfill: knowledge_item missing — dropping pin')
          continue
        }
        // Whether bound or not, the legacy buildKnowledgeSection emitted this
        // item (it had no connector-scoping gate). Include in
        // parsedItemsForStrip so safeStripAutoKnowledgeSection's line-by-line
        // match against the existing system_prompt still recognizes the
        // auto-generated section even when an orphan pin is being dropped.
        parsedItemsForStrip.push({ title: item.title, sourceUrl: item.sourceUrl })
        if (item.connectorId !== null && !boundConnectorIds.has(item.connectorId)) {
          backfillResult.pinsDroppedInvalid++
          backfillResult.invalidPinDetails.push({ id, reason: 'connector_not_bound' })
          log.warn({ agentId, tenantId, pinId: id, connectorId: item.connectorId }, 'backfill: connector not bound — dropping pin')
          continue
        }
        surviving.push(id)
      }
      backfillResult.pinsBackfilled = surviving.length
    }

    // Persist surviving IDs only when they differ from the existing column
    // (the column may have been backfilled by a prior run).
    const samePins = surviving.length === existingPinnedIds.length &&
      surviving.every((id, i) => id === existingPinnedIds[i])

    const strippedSystemPrompt = safeStripAutoKnowledgeSection(systemPrompt, parsedItemsForStrip)
    const systemPromptChanged = strippedSystemPrompt !== systemPrompt
    backfillResult.systemPromptStripped = systemPromptChanged

    if (!samePins || systemPromptChanged) {
      await withAdminScope({ caller: 'backfill-pinned-knowledge', reason: 'cross-tenant backfill of pinned-knowledge on internal_agents' }, (client) => client.query(
        `UPDATE internal_agents
            SET pinned_knowledge_ids = $1,
                system_prompt = $2,
                updated_at = NOW()
          WHERE id = $3 AND tenant_id = $4`,
        [surviving, strippedSystemPrompt, agentId, tenantId],
      ))
    }

    // Per-agent report. UPSERT so re-runs replace the prior row.
    await pool.query(
      `INSERT INTO pinned_knowledge_backfill_report
         (agent_id, tenant_id, pins_backfilled, pins_dropped_invalid,
          system_prompt_stripped, invalid_pin_details, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         pins_backfilled = EXCLUDED.pins_backfilled,
         pins_dropped_invalid = EXCLUDED.pins_dropped_invalid,
         system_prompt_stripped = EXCLUDED.system_prompt_stripped,
         invalid_pin_details = EXCLUDED.invalid_pin_details,
         processed_at = NOW()`,
      [
        agentId,
        tenantId,
        backfillResult.pinsBackfilled,
        backfillResult.pinsDroppedInvalid,
        backfillResult.systemPromptStripped,
        JSON.stringify(backfillResult.invalidPinDetails),
      ],
    )

    totals.agentsProcessed++
    totals.pinsBackfilled += backfillResult.pinsBackfilled
    totals.pinsDroppedInvalid += backfillResult.pinsDroppedInvalid
    if (backfillResult.systemPromptStripped) {
      totals.systemPromptsStripped++
    } else if (/\n\n## Knowledge\n/.test(systemPrompt)) {
      // A ## Knowledge section exists but didn't match the auto-generated
      // shape — operator hand-edited; we left it alone.
      totals.systemPromptsLeftAlone++
    }

    log.info({ ...backfillResult }, 'backfill: agent processed')
  }

  log.info(totals, 'backfill-pinned-knowledge: batch complete')
  return totals
}

backfillPinnedKnowledgeRouter.post('/', async (req, res) => {
  if (!validateServiceAuth(req, res)) return
  try {
    const totals = await runBackfillBatch()
    res.json({ status: 'ok', totals })
  } catch (err) {
    log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'backfill-pinned-knowledge: failed')
    res.status(500).json({ error: (err as Error).message })
  }
})
