/**
 * k6 load test: 200 concurrent SSE streams for 10 minutes.
 *
 * Asserts:
 *   - Zero dropped connections (http_req_failed < 1%)
 *   - p99 response duration < 5000ms (streaming to completion)
 *   - SSE events received across all streams > 0
 *
 * Usage:
 *   k6 run tools/load-test/k6-sse-streams.js
 *   BYOK_PROXY_URL=http://localhost:8080 k6 run tools/load-test/k6-sse-streams.js
 *
 * Requires a running byok-proxy with:
 *   - A valid liftoff_sk_test_* key configured in the DB
 *   - BYOK_PROXY_LOAD_TEST_KEY env var set to the test key
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const sseEventsReceived  = new Counter('sse_events_received');
const streamDuration     = new Trend('stream_duration_ms', true);
const streamByteCount    = new Counter('stream_bytes_total');
const streamErrorRate    = new Rate('stream_error_rate');
const partialStreamRate  = new Rate('stream_partial_rate');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const options = {
  vus: 200,
  duration: '10m',
  thresholds: {
    // Zero dropped connections
    'http_req_failed':      ['rate<0.01'],
    // p99 overall request duration (connection + first byte + full stream)
    'http_req_duration':    ['p(99)<5000'],
    // At least one SSE event received across all VUs
    'sse_events_received':  ['count>0'],
    // Stream error rate below 1%
    'stream_error_rate':    ['rate<0.01'],
    // p99 stream proxy overhead (time between first-byte and stream-end)
    'stream_duration_ms':   ['p(99)<5000'],
  },
};

// ---------------------------------------------------------------------------
// Test fixture — minimal Anthropic-compatible request body
// ---------------------------------------------------------------------------

const REQUEST_BODY = JSON.stringify({
  model:      'claude-haiku-4-5',
  max_tokens: 64,
  stream:     true,
  messages: [
    {
      role:    'user',
      content: 'Reply with exactly: "k6 test ok". No other text.',
    },
  ],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BYOK_PROXY_URL = __ENV.BYOK_PROXY_URL || 'http://localhost:8080';
const TEST_API_KEY   = __ENV.BYOK_PROXY_LOAD_TEST_KEY || 'liftoff_sk_test_loadtest000';

/**
 * Parse SSE events from a raw response body string.
 * Returns the count of data events received.
 */
function parseSseBody(body) {
  if (!body || typeof body !== 'string') return { eventCount: 0, hasMessageStart: false, hasDone: false };

  const lines = body.split('\n');
  let eventCount = 0;
  let hasMessageStart = false;
  let hasDone = false;

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') { hasDone = true; continue; }

    eventCount++;
    try {
      const obj = JSON.parse(payload);
      if (obj && obj.type === 'message_start') hasMessageStart = true;
    } catch {
      // malformed line — count as received but don't crash
    }
  }

  return { eventCount, hasMessageStart, hasDone };
}

// ---------------------------------------------------------------------------
// Main VU scenario
// ---------------------------------------------------------------------------

export default function () {
  const startMs = Date.now();

  const res = http.post(
    `${BYOK_PROXY_URL}/v1/messages`,
    REQUEST_BODY,
    {
      headers: {
        'content-type':     'application/json',
        'x-api-key':        TEST_API_KEY,
        'anthropic-version': '2023-06-01',
        'accept':           'text/event-stream',
      },
      // Use a long timeout to allow full stream completion
      timeout: '30s',
      // responseType 'text' captures the full SSE body
      responseType: 'text',
      tags: { name: 'sse_stream' },
    },
  );

  const elapsedMs = Date.now() - startMs;
  streamDuration.add(elapsedMs);

  const ok = check(res, {
    'status is 200':                  (r) => r.status === 200,
    'content-type is text/event-stream': (r) =>
      (r.headers['Content-Type'] || '').includes('text/event-stream'),
    'body is non-empty':              (r) => r.body && r.body.length > 0,
  });

  if (!ok) {
    streamErrorRate.add(1);
    return;
  }
  streamErrorRate.add(0);

  const { eventCount, hasMessageStart, hasDone } = parseSseBody(res.body);

  sseEventsReceived.add(eventCount);
  streamByteCount.add(res.body ? res.body.length : 0);

  check({ eventCount, hasMessageStart, hasDone }, {
    'received at least one SSE event': (s) => s.eventCount > 0,
    'message_start event present':     (s) => s.hasMessageStart,
    '[DONE] sentinel present':         (s) => s.hasDone,
  });

  // Record partial stream if [DONE] missing but some events received
  partialStreamRate.add(!hasDone && eventCount > 0 ? 1 : 0);

  // Minimal pacing: avoid hammering with zero sleep
  sleep(0.1);
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

export function setup() {
  console.log(`[k6-sse-streams] target: ${BYOK_PROXY_URL}`);
  console.log(`[k6-sse-streams] VUs: ${options.vus}, duration: ${options.duration}`);

  // Smoke test: verify proxy is reachable before ramping up
  const probe = http.get(`${BYOK_PROXY_URL}/health`, { timeout: '5s' });
  if (probe.status !== 200) {
    console.warn(`[k6-sse-streams] health check returned ${probe.status} — proceeding anyway`);
  }
}

export function teardown(data) {
  console.log('[k6-sse-streams] load test complete');
}
