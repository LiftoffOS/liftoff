// Tavily quota poller. /usage response shape verified live —
// account.plan_usage / account.plan_limit / account.current_plan are
// always present and load-bearing for the alert.

import { logger } from '../../infrastructure/logging';
import { getWebToolSecret } from './web-tool-secrets';

const ALERT_THRESHOLD_PCT = 80;
// Researcher allotment — 1,000 credits/mo gratis. With paygo enabled on the
// account, calls above this are charged $0.008/credit instead of being
// rejected, so the alert signals "transitioning to paid usage" rather than
// "service degradation". Defensive fallback when account.plan_limit comes
// back missing/non-positive. Bump in lockstep with any plan upgrade.
const RESEARCHER_PLAN_CREDITS_TOTAL = 1000;

interface TavilyUsageResponse {
  key: {
    usage: number;
    limit: number | null;
    search_usage: number;
    extract_usage: number;
    crawl_usage: number;
    map_usage: number;
    research_usage: number;
  };
  account: {
    current_plan: string;
    plan_usage: number;
    plan_limit: number;
    search_usage: number;
    extract_usage: number;
    crawl_usage: number;
    map_usage: number;
    research_usage: number;
    paygo_usage: number;
    paygo_limit: number | null;
  };
}

export async function pollTavilyQuota(): Promise<void> {
  const apiKey = await getWebToolSecret('tavily-api-key');
  if (!apiKey) return;
  let res: Response;
  try {
    res = await fetch('https://api.tavily.com/usage', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'tavily quota poll failed');
    return;
  }
  if (!res.ok) { logger.warn({ status: res.status }, 'tavily quota poll non-2xx'); return; }
  const parsed = await res.json() as TavilyUsageResponse;

  const total = parsed.account.plan_limit > 0
    ? parsed.account.plan_limit
    : RESEARCHER_PLAN_CREDITS_TOTAL;
  const used = parsed.account.plan_usage;

  const utilPct = (used / total) * 100;
  if (utilPct >= ALERT_THRESHOLD_PCT) {
    logger.warn({
      event: 'tavily_quota_high',
      util_pct: utilPct,
      credits_used: used,
      credits_total: total,
      plan: parsed.account.current_plan,
      // Per-endpoint usage breakdown helps the operator diagnose which tool
      // is burning credits (search vs extract vs unused crawl/map).
      search_usage: parsed.account.search_usage,
      extract_usage: parsed.account.extract_usage,
    }, 'tavily_quota_high');
  }
}
