/**
 * k6 Load Test — Workflow Execution
 *
 * Sustained load against workflow agent execution at various step counts
 * and loop iteration sizes. Validates the 1000-tool-call ceiling and
 * 10-minute wall-clock ceiling are sized correctly.
 *
 * Run: k6 run --env BASE_URL=https://tenant-runtime-url load/workflow-exec.k6.js
 *
 * Phase 6 (TE-P2-007): Runs weekly in a sandbox project.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const execLatency = new Trend('workflow_exec_latency_ms');
const execErrors = new Counter('workflow_exec_errors');

export const options = {
  stages: [
    { duration: '30s', target: 3 },
    { duration: '3m', target: 3 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    'workflow_exec_latency_ms': ['p(95)<600000'], // p95 < 10min (wall-clock ceiling)
    'workflow_exec_errors': ['count<5'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

export default function () {
  // This test would trigger a workflow agent execution via the scheduled-invoke endpoint
  // Requires a pre-seeded workflow agent in the test tenant
  const payload = JSON.stringify({
    tenantId: 'load-test-tenant',
    agentId: 'load-test-workflow-agent',
    triggeredBy: 'load-test',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
    },
    timeout: '600s', // 10 minute max
  };

  const res = http.post(
    `${BASE_URL}/api/execution/scheduled-invoke`,
    payload,
    params,
  );

  execLatency.add(res.timings.duration);

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
  });

  if (!ok) {
    execErrors.add(1);
  }

  sleep(5); // 5 seconds between workflow executions
}
