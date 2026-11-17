// Admin surface for the four platform vendor levers.
//
// Mounted under /api/admin, so it inherits adminAuthMiddleware from the parent
// router — platform admin only, like every other route there.
//
// GET  /api/admin/platform-vendors   → the four areas, and what each may be set to
// PUT  /api/admin/platform-vendors   → move one or more levers
//
// The point of a route rather than a constant is that a vendor timing out at 2am
// should be a click rather than a build. The cost of that is an actor and an
// audit line per change, which is why both are required here.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPool } from '../infrastructure/database';
import { log, logAudit } from '../infrastructure/logging';
import { publishEvent } from '../events/publisher';
import { llmClient } from '../llm/client';
import {
  PLATFORM_VENDOR_AREAS,
  areaForPurpose,
  platformVendorPolicy,
  resolvePlatformVendorTarget,
  selectablePlatformVendors,
  type PlatformVendorArea,
} from '../model-registry/platform-vendor-policy';
import type { WorkspaceAiSelection } from '../model-registry/workspace-ai-vendors';
import { refreshPlatformVendorPolicy } from '../model-registry/platform-vendor-policy-loader';

export const platformVendorRouter = Router();

/** What each area means, in the words the admin screen should use. Kept beside
 *  the route so the surface does not have to restate the areas and drift. */
const AREA_DESCRIPTIONS: Record<PlatformVendorArea, string> = {
  assistants:
    'What a person reads: Liftoff, the Chief AI Officer, the Insights Manager and the HRBP.',
  agent_shaping:
    'Work that decides what an agent is: distillation, capability and template analysis.',
  quiet_work:
    'High-volume background work nobody watches: titles, compaction, recall, reflection.',
  safety:
    'Gates: injection screening, untrusted content, data-loss scanning, classifications.',
};

/** The vendors this plane can actually route to, so the screen offers no option
 *  that would be accepted and then quietly ignored.
 *
 *  TWO conditions, because being routable in principle is not the same as being
 *  servable here. `selectablePlatformVendors()` answers the first from the
 *  vendor map — whether a transport and a tier model exist. The second is
 *  whether THIS environment holds a client for the provider that transport
 *  lands on: a gateway vendor with no OpenRouter key is perfectly routable and
 *  completely inert, and the LLM client would keep the default and say so in a
 *  log nobody is reading. Refusing at the edit is where an operator can act on
 *  it.
 *
 *  An empty availability list means the client has not initialised yet, not
 *  that nothing is configured — so the second condition is skipped rather than
 *  refusing every vendor on a cold process. */
function selectable(): WorkspaceAiSelection[] {
  const routable = selectablePlatformVendors();
  const available = new Set(llmClient.getAvailableProviders());
  if (available.size === 0) return routable;
  return routable.filter((v) => {
    const target = resolvePlatformVendorTarget(v, 'medium');
    return target === null || available.has(target.provider);
  });
}

platformVendorRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const current = platformVendorPolicy();
    res.json({
      areas: PLATFORM_VENDOR_AREAS.map((area) => ({
        area,
        description: AREA_DESCRIPTIONS[area],
        vendor: current[area],
        // What this setting resolves to right now, so the screen can say
        // whether a lever is actually taking effect rather than only what it
        // was set to. A vendor this plane cannot reach resolves to null.
        resolves: resolvePlatformVendorTarget(current[area], 'medium'),
      })),
      selectableVendors: selectable(),
      // Which providers this environment actually holds a client for. A vendor
      // missing from `selectableVendors` that is in the vocabulary is missing
      // because of this list, and the screen can say so.
      availableProviders: llmClient.getAvailableProviders(),
    });
  } catch (err) {
    log.error({ err }, 'platform vendor policy read failed');
    res.status(500).json({ error: 'internal_error' });
  }
});

const putSchema = z.object({
  areas: z
    .record(z.enum(PLATFORM_VENDOR_AREAS as unknown as [string, ...string[]]), z.string())
    .refine((v) => Object.keys(v).length > 0, { message: 'name at least one area' }),
});

platformVendorRouter.put('/', async (req: Request, res: Response) => {
  const parsed = putSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.errors });
    return;
  }

  // REFUSED, not accepted-and-ignored. A lever set to a vendor this plane
  // cannot route to would read as configured on the screen and change nothing
  // at all — the worst of both. Grok is the live case: it left the gateway for
  // api.x.ai and the control plane holds no xAI client.
  const allowed = new Set(selectable());
  const rejected = Object.entries(parsed.data.areas)
    .filter(([, vendor]) => !allowed.has(vendor as never))
    .map(([area, vendor]) => ({ area, vendor }));
  if (rejected.length > 0) {
    res.status(400).json({
      error: 'vendor_not_routable',
      rejected,
      selectableVendors: selectable(),
      availableProviders: llmClient.getAvailableProviders(),
    });
    return;
  }

  const actor = req.user?.uid ?? 'unknown';
  try {
    const entries = Object.entries(parsed.data.areas) as Array<[PlatformVendorArea, string]>;
    const pool = getPool();
    const before = platformVendorPolicy();

    for (const [area, vendor] of entries) {
      // Upsert rather than update: migration 553 seeds all four, but a row
      // deleted by hand should not make a lever unsettable.
      await pool.query(
        `INSERT INTO platform_vendor_policy (area, vendor, updated_by, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (area) DO UPDATE
           SET vendor = EXCLUDED.vendor,
               updated_by = EXCLUDED.updated_by,
               updated_at = NOW()`,
        [area, vendor, actor],
      );
    }

    // Install it in THIS process at once, so the admin's own next request sees
    // the change rather than waiting on the poll.
    const applied = await refreshPlatformVendorPolicy();

    // And tell the other plane. The tenant runtime holds its own copy; without
    // this it would wait out its backstop poll, which is the difference between
    // a lever that is fast and one that is merely eventual.
    await publishEvent({
      eventType: 'platform.vendor_policy.updated',
      entityType: 'platform_vendor_policy',
      entityId: 'singleton',
      entityVersion: null,
      eventVersion: 1,
      tenantId: null,
    });

    for (const [area, vendor] of entries) {
      logAudit('platform_vendor_policy.updated', { adminId: actor }, {
        area,
        from: before[area],
        to: vendor,
      });
    }

    res.json({ applied, policy: platformVendorPolicy() });
  } catch (err) {
    log.error({ err, actor }, 'platform vendor policy write failed');
    res.status(500).json({ error: 'internal_error' });
  }
});

/** Operator diagnostic: what does a given purpose actually resolve to?
 *
 *  A "the assistants are still on Anthropic" report should be a curl, not a
 *  reading of areaForPurpose. Answers with the area the purpose lands in, the
 *  lever that area is on, and what that resolves to on this plane — which is
 *  where a lever set to an unroutable vendor becomes visible. */
platformVendorRouter.get('/resolve/:purpose', (req: Request, res: Response) => {
  const purpose = req.params.purpose;
  const area = areaForPurpose(purpose);
  const vendor = platformVendorPolicy()[area];
  res.json({
    purpose,
    area,
    vendor,
    resolves: resolvePlatformVendorTarget(vendor, 'medium'),
  });
});
