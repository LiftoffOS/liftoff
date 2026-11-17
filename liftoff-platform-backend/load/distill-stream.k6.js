/**
 * k6 Load Test — Distill Stream Endpoint
 *
 * Sustained load against /api/internal-agents/distill-stream with realistic
 * integration counts. Captures p50/p95/p99 latency, LLM token spend.
 *
 * Run: k6 run --env BASE_URL=https://api.example.com load/distill-stream.k6.js
 *
 * Phase 6 (TE-P2-007): Runs weekly in a sandbox project. Results feed
 * rate-limit and budget configuration.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const distillLatency = new Trend('distill_latency_ms');
const distillErrors = new Counter('distill_errors');

export const options = {
  stages: [
    { duration: '30s', target: 5 },   // Ramp up to 5 VUs
    { duration: '2m', target: 5 },    // Sustained load
    { duration: '30s', target: 10 },  // Spike to 10
    { duration: '1m', target: 10 },   // Sustained spike
    { duration: '30s', target: 0 },   // Ramp down
  ],
  thresholds: {
    'distill_latency_ms': ['p(95)<15000'], // p95 < 15s (matches alert threshold)
    'distill_errors': ['count<10'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

export default function () {
  const payload = JSON.stringify({
    role: 'Sales Follow-up Manager',
    responsibilities: 'Every hour, check Salesforce for deals stuck in negotiation for more than 7 days and draft a follow-up plan',
    integrations: [
      { id: 'int-1', name: 'Salesforce', type: 'salesforce', selectedObjects: ['Lead', 'Contact', 'Opportunity'] },
    ],
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
    },
    timeout: '30s',
  };

  const res = http.post(
    `${BASE_URL}/api/internal-agents/distill-stream?tenantId=load-test-tenant`,
    payload,
    params,
  );

  distillLatency.add(res.timings.duration);

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'not rate limited': (r) => r.status !== 429,
  });

  if (!ok) {
    distillErrors.add(1);
  }

  sleep(1); // 1 second between requests per VU
}
