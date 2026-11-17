/**
 * k6 load test — ReportUsage at 500 RPS (plan Phase 1 SLO target).
 *
 * Usage:
 *   k6 run --env BASE_URL=https://billing-dev.internal \
 *           --env SERVICE_TOKEN=... \
 *           tools/load-test/k6-report-usage.js
 *
 * Targets:
 *   - 500 RPS sustained for 60 s after 30 s ramp
 *   - p99 latency < 200 ms
 *   - error rate < 0.5%
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('billing_errors');
const reportUsageTrend = new Trend('report_usage_duration', true);
const duplicateCounter = new Counter('duplicate_events');

export const options = {
  scenarios: {
    report_usage: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 600,
      stages: [
        { duration: '30s', target: 500 }, // ramp to 500 RPS
        { duration: '60s', target: 500 }, // sustain at 500 RPS
        { duration: '10s', target: 0 },   // ramp down
      ],
    },
  },
  thresholds: {
    billing_errors: ['rate<0.005'],          // < 0.5% error rate
    report_usage_duration: ['p(99)<200'],    // p99 < 200 ms
    http_req_failed: ['rate<0.005'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3100';
const SERVICE_TOKEN = __ENV.SERVICE_TOKEN || 'dev-token';

// Pre-build a pool of tenant IDs to distribute load
const TENANTS = Array.from({ length: 50 }, (_, i) =>
  `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
);

export default function () {
  const tenantId = TENANTS[Math.floor(Math.random() * TENANTS.length)];
  const requestId = `load-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const payload = JSON.stringify({
    tenantId,
    vendor: 'anthropic',
    requestId,
    eventType: 'claude.tokens',
    quantity: 1000,
    occurredAt: new Date().toISOString(),
    costMicros: 1500,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Auth': SERVICE_TOKEN,
      'X-Tenant-Id': tenantId,
    },
    timeout: '5s',
  };

  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/liftoff.billing.v1.BillingService/ReportUsage`,
    payload,
    params,
  );
  reportUsageTrend.add(Date.now() - start);

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'no error field': (r) => {
      try {
        const body = JSON.parse(r.body);
        return !body.error;
      } catch {
        return false;
      }
    },
  });

  if (!ok) errorRate.add(1);
  else errorRate.add(0);

  // Track idempotency — second call with same requestId should return created=false
  if (Math.random() < 0.05) {
    const dupeRes = http.post(
      `${BASE_URL}/liftoff.billing.v1.BillingService/ReportUsage`,
      payload,
      params,
    );
    if (dupeRes.status === 200) {
      try {
        const body = JSON.parse(dupeRes.body);
        if (body.created === false) duplicateCounter.add(1);
      } catch {
        // ignore parse errors
      }
    }
  }
}
