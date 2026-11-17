// Web Tools Internal Jobs Router
//
// Cloud Scheduler-triggered endpoints for web-tool vendor cost monitoring
// and monthly reconciliation. Each endpoint is service-auth gated.

import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { log } from '../infrastructure/logging';
import { monitorVendorSpend } from './vendor-spend-monitor';
import { reconcileVendorSpend } from './vendor-reconciliation';
import { runAllIngesters } from '../cost-attribution/ingestion/ingest-runner';
import {
  INGEST_SOURCES, type IngestScope, type IngestSource,
} from '../cost-attribution/ingestion/ingest-scope';
import { settlePendingAutoReloads } from '../cost-attribution/reload-drain';
import { runAutoReloadSweep } from '../billing/auto-reload-sweep';
import { runSnapshotService } from '../cost-attribution/snapshot-service';

export const webToolsJobsRouter = Router();

function validateServiceAuth(req: Request, res: Response): boolean {
  const serviceToken = req.headers['x-service-auth'] as string | undefined;
  const expectedToken = process.env.PLATFORM_CALLBACK_TOKEN;
  if (!expectedToken) {
    res.status(500).json({ error: 'Service authentication not configured' });
    return false;
  }
  const isValid =
    serviceToken &&
    Buffer.byteLength(serviceToken) === Buffer.byteLength(expectedToken) &&
    crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expectedToken));
  if (!isValid) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return false;
  }
  return true;
}

/** The cost pass's scope from its request body, or null when the body names
 *  something that is not a source or a workspace id. */
function parseIngestScope(body: unknown): IngestScope | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const scope: IngestScope = {};
  if (b.sources !== undefined) {
    if (!Array.isArray(b.sources) || b.sources.length === 0
      || !b.sources.every((s) => INGEST_SOURCES.includes(s as IngestSource))) return null;
    scope.sources = b.sources as IngestSource[];
  }
  if (b.tenantId !== undefined) {
    if (typeof b.tenantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(b.tenantId)) return null;
    scope.tenantId = b.tenantId;
  }
  return scope;
}

// POST /api/internal/jobs/vendor-spend-monitor
// Daily. Logs vendor_spend_high if MTD spend hits 80% of tier limit.
webToolsJobsRouter.post('/vendor-spend-monitor', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    await monitorVendorSpend();
    res.json({ ok: true });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'vendor-spend-monitor failed');
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/internal/jobs/cost-attribution-ingest
// Service-auth-gated entry point for the Cloud Scheduler that drives all
// cost-attribution ingesters. The existing /api/cost-attribution/internal/ingest
// route sits behind app-level authMiddleware (Firebase JWT) and rejects
// Cloud Scheduler's X-Service-Auth header. This route lives BEFORE
// authMiddleware (mounted at /api/internal/jobs) and uses validateServiceAuth
// directly — the same convention as the maintenance and platform-tools
// internal routers.
//
// The hour's whole cost pass, in order and inside the request: ingest (which
// is the money brake's reaction time, so a workspace at zero is stopped within
// the hour), the auto-reload sweep, then the hourly snapshot over what was just
// ingested. A failure in one step is logged and does not skip the next; the
// response reports each. It answers only after every reload call it fired has
// settled, because nothing runs here once the request has ended.
//
// The body may narrow the ingest to the source that spent ({ sources,
// tenantId }, see IngestScope); an empty body, as the daily pass sends, reads
// every feed. Anything it does not recognise is a 400 rather than a silently
// wider or narrower pass.
webToolsJobsRouter.post('/cost-attribution-ingest', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  const scope = parseIngestScope(req.body);
  if (!scope) {
    res.status(400).json({ error: 'invalid ingest scope' });
    return;
  }
  const step =async <T>(name: string, fn: () => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> => {
    try {
      return { ok: true, result: await fn() };
    } catch (err) {
      log.error({ error: (err as Error).message, step: name }, 'cost-attribution: scheduled step failed');
      return { ok: false, error: (err as Error).message };
    }
  };
  const ingest = await step('ingest', () => runAllIngesters(scope));
  const autoReloadSweep = await step('auto_reload_sweep', runAutoReloadSweep);
  const snapshot = await step('snapshot', runSnapshotService);
  await settlePendingAutoReloads();
  const ok = ingest.ok && autoReloadSweep.ok && snapshot.ok;
  log.info({ ingest, autoReloadSweep, snapshot }, 'cost-attribution: scheduled hourly pass complete');
  res.status(ok ? 200 : 500).json({ ok, ingest, autoReloadSweep, snapshot });
});

// POST /api/internal/jobs/vendor-reconciliation
// Monthly. Logs MTD vendor cost totals; runs against the previous month
// when called on the first of the month.
webToolsJobsRouter.post('/vendor-reconciliation', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    // Default: previous month in UTC.
    const explicitMonth = (req.body && typeof (req.body as Record<string, unknown>).month === 'string')
      ? ((req.body as Record<string, unknown>).month as string)
      : undefined;
    let month = explicitMonth;
    if (!month) {
      const now = new Date();
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      month = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    await reconcileVendorSpend(month);
    res.json({ ok: true, month });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'vendor-reconciliation failed');
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

