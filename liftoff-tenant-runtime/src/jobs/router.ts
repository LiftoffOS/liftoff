// Jobs Router
// HTTP entry points for Cloud Scheduler-triggered background jobs.
// Each endpoint corresponds to a periodic job invoked by Cloud Scheduler via
// POST. The new web-tools jobs (web-sessions-reap, anchor-quota-poll) are
// service-auth-gated via requireServiceAuth() — defense in depth on top of the
// Cloud Run ingress controls.

import { Router, Request, Response } from 'express';
import { logger } from '../infrastructure/logging';
import { SessionReaper } from '../integrations/web-fetch/session-reaper';
import { anchorClient, browserbaseClient, browserUseClient } from '../tools/standard-tool-handler';
import { pollAnchorQuota } from '../integrations/web-fetch/anchor-quota-monitor';
import { pollFirecrawlQuota } from '../integrations/web-fetch/firecrawl-quota-monitor';
import { pollTavilyQuota } from '../integrations/web-fetch/tavily-quota-monitor';
import { runByokReprobeCycle } from '../integrations/web-fetch/byok-reprobe';
import { requireServiceAuth } from '../security/service-auth';

export const jobsRouter = Router();

// NOTE: billing-queued-reconciliation used to live here, unauthenticated while
// every sibling below is service-auth gated. It has moved to
// /api/internal/billing-queued-reconciliation on internal-cron-handler — the
// router Cloud Scheduler actually reaches. Adding requireServiceAuth() here
// instead would have looked like the fix and 401ed on every fire, because the
// scheduler sends an OIDC token and no shared secret.

// POST /api/jobs/web-sessions-reap
// Closes expired vendor browser sessions. Cloud Scheduler triggers every 5 min.
jobsRouter.post('/web-sessions-reap', requireServiceAuth(), async (_req: Request, res: Response) => {
  try {
    const reaper = new SessionReaper(anchorClient, browserbaseClient, browserUseClient);
    const result = await reaper.sweep();
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({
      message: 'web-sessions-reap job failed',
      error: (err as Error).message,
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/jobs/anchor-quota-poll
// Reports Anchor vendor quota utilization above 80% as a log-based metric.
jobsRouter.post('/anchor-quota-poll', requireServiceAuth(), async (_req: Request, res: Response) => {
  try {
    await pollAnchorQuota();
    res.json({ ok: true });
  } catch (err) {
    logger.error({
      message: 'anchor-quota-poll job failed',
      error: (err as Error).message,
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/jobs/firecrawl-quota-poll
// Reports Firecrawl vendor quota utilization above 80% as a log-based metric.
// Free plan ceiling = 1,000 pages/mo; alert at 800.
jobsRouter.post('/firecrawl-quota-poll', requireServiceAuth(), async (_req: Request, res: Response) => {
  try {
    await pollFirecrawlQuota();
    res.json({ ok: true });
  } catch (err) {
    logger.error({
      message: 'firecrawl-quota-poll job failed',
      error: (err as Error).message,
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/jobs/tavily-quota-poll
// Reports Tavily vendor quota utilization above 80% as a log-based metric.
// Researcher (free) plan ceiling = 1,000 credits/mo; alert at 800.
jobsRouter.post('/tavily-quota-poll', requireServiceAuth(), async (_req: Request, res: Response) => {
  try {
    await pollTavilyQuota();
    res.json({ ok: true });
  } catch (err) {
    logger.error({
      message: 'tavily-quota-poll job failed',
      error: (err as Error).message,
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/jobs/byok-reprobe
// Cross-tenant scan of connectors flipped to status='error' with
// error_code='byok_insufficient_funds'. Probes vendor balance endpoints
// for firecrawl/anchor_browser/browserbase; on healthy response, calls
// ClearConnectorError to restore the connector. Cloud Scheduler should
// invoke every ~15 minutes (configured in liftoff-infrastructure-gcp/
// tenant-runtime-template). Vendors without a balance probe endpoint
// (tavily, exa, webclaw) and invalid_key errors are NOT auto-restored —
// those require a tenant-initiated key update via /connections.
jobsRouter.post('/byok-reprobe', requireServiceAuth(), async (_req: Request, res: Response) => {
  try {
    await runByokReprobeCycle();
    res.json({ ok: true });
  } catch (err) {
    logger.error({
      message: 'byok-reprobe job failed',
      error: (err as Error).message,
    });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// NOTE: /api/jobs/perplexity-quota-poll dropped per plan TR-6 blocking-prerequisite
// escape clause — Perplexity exposes no programmatic spend/usage endpoint (verified
// against https://docs.perplexity.ai/ at code time). Vendor MTD spend is still
// tracked end-to-end via cost-attribution (PB-2 vendor-spend-monitor consumes
// cost_attribution_events). Re-add this route once Perplexity ships a usage API.
