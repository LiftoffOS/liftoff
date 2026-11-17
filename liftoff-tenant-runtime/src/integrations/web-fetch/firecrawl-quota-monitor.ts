import { logger } from '../../infrastructure/logging';
import { getWebToolSecret } from './web-tool-secrets';

const ALERT_THRESHOLD_PCT = 80;
// Free plan ceiling — 1,000 pages/mo. Bump in lockstep with the plan upgrade.
const FREE_PLAN_CREDITS_TOTAL = 1000;
const PLAN = 'free';

// Per Firecrawl docs (GET /team/credit-usage):
//   { credits: <remaining>, used: <consumed>, total: <plan ceiling> }
// Some response variants also expose `remainingCredits` (Go/Java SDK shape).
// Read both and prefer the one that gives a sane number; fall back to the
// Free-plan default if neither is present.
interface FirecrawlCreditResponse {
  credits?: number;
  used?: number;
  total?: number;
  remainingCredits?: number;
  remaining_credits?: number;
}

export async function pollFirecrawlQuota(): Promise<void> {
  const apiKey = await getWebToolSecret('firecrawl-api-key');
  if (!apiKey) return;
  let res: Response;
  try {
    res = await fetch('https://api.firecrawl.dev/v2/team/credit-usage', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'firecrawl quota poll failed');
    return;
  }
  if (!res.ok) { logger.warn({ status: res.status }, 'firecrawl quota poll non-2xx'); return; }
  const parsed = await res.json() as FirecrawlCreditResponse;

  // Prefer `total` when present (authoritative). Otherwise fall back to the
  // hardcoded Free-plan ceiling.
  const total = typeof parsed.total === 'number' && parsed.total > 0
    ? parsed.total
    : FREE_PLAN_CREDITS_TOTAL;

  // `used` is the simplest signal to alert on. If absent, derive it from
  // (total - remaining) so the alert still works on shape variants.
  const remaining = parsed.remainingCredits ?? parsed.remaining_credits ?? parsed.credits;
  const used = typeof parsed.used === 'number'
    ? parsed.used
    : (typeof remaining === 'number' ? Math.max(0, total - remaining) : 0);

  const utilPct = (used / Math.max(total, 1)) * 100;
  if (utilPct >= ALERT_THRESHOLD_PCT) {
    logger.warn({
      event: 'firecrawl_quota_high',
      util_pct: utilPct,
      credits_used: used,
      credits_total: total,
      plan: PLAN,
    }, 'firecrawl_quota_high');
  }
}
