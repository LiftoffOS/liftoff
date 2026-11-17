// Connector-service RPC-hop latency benchmark.
//
// Phase 1 fix-12 budget gate for the in-process Connect-RPC hop (Express → connect
// middleware → registered handler → executor → response). Everything is in-process:
//   - `buildApp` produces the real Express app (same one Cloud Run boots).
//   - It binds to an ephemeral localhost port via `http.createServer`.
//   - The Connect client talks to `http://127.0.0.1:<port>` with HTTP/1.1.
//   - `credentialService.getCredentials`/`getConnectorConfig`/`warmCredentialsByType`
//     are stubbed so there is zero DB or Secret Manager traffic.
//   - A trivial no-op executor is registered for `test_bench`.
//
// GATE DESIGN — ratio, not absolute ms. This benchmark runs on Cloud Build's default
// 2-vCPU (e2-standard-2) VM, where the jest runner, the in-process server, and the client
// all contend for 2 cores. Absolute-ms p95/p99 budgets on that VM measure GC + scheduler
// JITTER, not code — the previous absolute budgets were bumped THREE times for exactly that
// flakiness and still false-failed deploys. Instead we measure a BASELINE in the SAME run and
// assert the RPC hop is within `RATIO_MAX×` it. VM speed + jitter hit both numerator and
// denominator, so they cancel; the ratio isolates the hop's own overhead.
//
// BASELINE CHOICE — the SAME app server's `/health` route, not a separate bare loopback ping.
// `/health` is mounted before `verifyServiceAuth`, so it exercises the identical stack up to the
// point the RPC diverges: same Node http server, same event loop, same request-id middleware,
// same Express router — it just returns a static JSON body instead of running the connect
// middleware → dispatcher → proto marshaller. So the RPC/`/health` ratio isolates EXACTLY that
// connect+dispatch+proto delta, and — because both round-trips share one process and one jitter
// window — the ratio is small (~2-5×) and STABLE run-to-run. (A bare loopback ping, by contrast,
// omits Express entirely, so its sub-ms p95 swung 0.4-2ms and pushed the ratio to a noisy 6-20×,
// forcing a loose 50× ceiling. Routing the baseline through the real app fixes that at the source.)
// A genuine regression in the connect middleware / router / dispatcher / proto marshaller inflates
// the RPC but not `/health` → the ratio climbs → the build fails. Loose absolute ceilings catch
// only catastrophic hangs. The gate stays BLOCKING (that's the point of a gate); it just no longer
// fails on noise. Slowest 1% of samples trimmed to drop single-GC-pause sensitivity.
//
// Run with: npm run bench   (uses --bail — the first breach fails the build)

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { ConnectorService } from '@liftoffos/proto-gen';
import { buildApp } from '../server.js';
import { logger } from '../infra/logging.js';
import * as credService from '../credentials/service.js';
import {
  registerConnectorExecutor,
  unregisterAllConnectorExecutors,
} from '../rpc/execute-dispatcher.js';
import {
  assertLatencyRatio,
  formatStats,
  measureLatencies,
} from '../test-utils/benchmark.js';

// CALIBRATED from measured CI data (threshold-from-measurement, not intuition). With the `/health`
// baseline the ratio is VM-speed-INDEPENDENT — Execute measured 2.6-3.05× on BOTH the contended
// 2-vCPU Cloud Build VM and the roomy GitHub-Actions runner (near-identical despite CB being ~8×
// slower in absolute ms). That is the whole win: a real gate, not the old 50× catastrophe-only
// placeholder.
//
// PER-TEST thresholds, because the two ops have measurably different noise profiles:
//   - Execute is STABLE: 2.59-3.05× across every run (both builder VMs). A tight 6× gate gives
//     ~2× headroom and catches a genuine ~2× regression in the connect/dispatch/proto hop.
//   - Warm SWINGS: 2.11-6.35×. Its `/health` baseline p95 is a smaller, noisier denominator (e.g.
//     1.60ms vs 5.29ms for the SAME endpoint within one build — GC/scheduler windows), so a low
//     baseline sample lifts the ratio. 13× = ~2× its worst observed (6.35×), keeping it
//     noise-proof; going tighter would re-risk the flakiness this whole change removed.
// Observed healthy p95 ratios (Cloud Build): Execute 2.66 / 2.75 / 3.05×; Warm 2.11 / 4.61 / 5.09 / 6.35×.
const RATIO_MAX_EXECUTE = 6; // Execute is stable (2.6-3.0×) → tight gate, ~2× regression sensitivity
const RATIO_MAX_WARM = 13; // Warm swings (2.1-6.35×) → ~2× its worst observed; noise-proof
//
// THE ABSOLUTE CEILINGS ARE HANG DETECTORS, NOT THE GATE — and they were set
// too tight to be either. The ratio above is VM-speed-independent by
// construction, which is this file's whole design; the ms ceilings never were,
// so they drifted back into measuring exactly the jitter the ratio was
// introduced to cancel.
//
// Calibrated from the observed spread of Execute runs. p95, in ms:
// 29.2 / 30.4 / 30.6 / 87.0 / 99.9 / 103.9 / 122.4 / 131.9 / 159.6 / 166.7, and
// p99 to 206.2 — against a 120ms p95 ceiling that sat BELOW two-thirds of that
// range, and a 250ms p99 ceiling already 82% spent.
//
// HOW WIDE THE NOISE REALLY IS, measured on ONE unchanged commit run five
// times: p95 87.0 / 122.4 / 131.9 / 159.6 / 166.7ms, ratio 1.58× / 4.39× /
// 4.51× / 4.57× / 12.71×. Four of those five failed and the fifth passed, with
// no code change between them. A local A/B of that commit against its parent
// on identical hardware measured Execute p50 0.254ms vs 0.255ms, and the change
// under test added 12KB to a catalog the measured path never reads — so there
// was never a regression to catch.
//
// The 12.71× sample is the one worth keeping in mind: the ratio cancels VM
// speed only when both halves move together, and on a quiet builder the
// `/health` baseline can fall to 12.6ms while the allocating RPC path stays at
// 159ms. The ratio is still much the best signal available here, which is why
// it stays as it is — but it is not the invariant its budget assumes, and the
// absolute ceilings underneath it must not be tight enough to fire first.
//
// Set at ~3× the worst observed, which is far above any jitter this VM
// produces and far below a genuine hang (seconds, not hundreds of ms). A real
// dispatch regression inflates the RPC without inflating `/health`, so the
// RATIO catches it — these two only catch the case where everything is broken
// at once and the ratio therefore stays flat.
const ABS_P95_MAX = 500;
const ABS_P99_MAX = 750;
const TRIM = 0.01; // drop slowest 1% before percentiles
const ITERATIONS = 1000;
const WARMUP = 50;

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return silentLog;
  },
} as unknown as typeof logger;

function startServer(): Promise<{ server: http.Server; baseUrl: string }> {
  process.env.CONNECTOR_SERVICE_TOKEN = 'bench-token';
  const app = buildApp({ port: 0, log: silentLog });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

// Baseline round-trip — GET /health on the SAME app server. /health is mounted before
// verifyServiceAuth, so it runs the identical Node http server + event loop + request-id
// middleware + Express router as the RPC, diverging only where the RPC adds the connect
// middleware → dispatcher → proto marshaller. Measuring it in the same run means VM speed +
// GC/scheduler jitter hit both it and the RPC together, so the RPC/health ratio cancels the
// environment and isolates exactly the hop's own overhead.
function healthPing(baseUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/health`, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
  });
}

function tenantContext(tenantId: string) {
  return { tenantId, tier: '', projectId: '' };
}

function makeClient(baseUrl: string) {
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: '1.1',
    interceptors: [
      (next) => async (req) => {
        req.header.set('X-Service-Auth', 'bench-token');
        return next(req);
      },
    ],
  });
  return createClient(ConnectorService, transport);
}

describe('connector-service RPC-hop latency', () => {
  let server: http.Server;
  let baseUrl: string;
  let client: ReturnType<typeof makeClient>;
  const originalToken = process.env.CONNECTOR_SERVICE_TOKEN;

  beforeAll(async () => {
    const started = await startServer();
    server = started.server;
    baseUrl = started.baseUrl;
    client = makeClient(started.baseUrl);

    jest
      .spyOn(credService.credentialService, 'getCredentials')
      .mockResolvedValue({ flowKind: 'api_key', apiKey: 'bench' });
    jest
      .spyOn(credService.credentialService, 'getConnectorConfig')
      .mockResolvedValue({ connectorType: 'test_bench', config: {} });
    jest
      .spyOn(credService, 'warmCredentialsByType')
      .mockResolvedValue({ warmedTypes: [], failures: [] });

    unregisterAllConnectorExecutors();
    registerConnectorExecutor('test_bench', async () => ({ result: {} }));
  });

  afterAll(async () => {
    unregisterAllConnectorExecutors();
    jest.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalToken === undefined) delete process.env.CONNECTOR_SERVICE_TOKEN;
    else process.env.CONNECTOR_SERVICE_TOKEN = originalToken;
  });

  it(`Execute p95 within ${RATIO_MAX_EXECUTE}× a /health baseline`, async () => {
    // Baseline measured right before the RPC → same VM/GC window, best jitter cancellation.
    const baseline = await measureLatencies({ iterations: ITERATIONS, warmup: WARMUP, trimTopFraction: TRIM, fn: () => healthPing(baseUrl) });
    const stats = await measureLatencies({
      iterations: ITERATIONS,
      warmup: WARMUP,
      trimTopFraction: TRIM,
      fn: () =>
        client.execute({
          tenantContext: tenantContext('bench-tenant'),
          connectorId: 'bench-conn',
          functionName: 'bench_op',
          input: {},
          idempotencyKey: 'idem',
          traceId: 'trace',
        }),
    });

    // eslint-disable-next-line no-console
    console.log(formatStats('Execute baseline', baseline));
    // eslint-disable-next-line no-console
    console.log(formatStats('Execute RPC', stats));
    const { ratio } = assertLatencyRatio(stats, baseline, { ratioMax: RATIO_MAX_EXECUTE, absP95Max: ABS_P95_MAX, absP99Max: ABS_P99_MAX }, 'Execute RPC');
    // eslint-disable-next-line no-console
    console.log(`Execute RPC/baseline p95 ratio = ${ratio.toFixed(2)}× (budget ${RATIO_MAX_EXECUTE}×)`);
  });

  it(`Warm p95 within ${RATIO_MAX_WARM}× a /health baseline`, async () => {
    const baseline = await measureLatencies({ iterations: ITERATIONS, warmup: WARMUP, trimTopFraction: TRIM, fn: () => healthPing(baseUrl) });
    const stats = await measureLatencies({
      iterations: ITERATIONS,
      warmup: WARMUP,
      trimTopFraction: TRIM,
      fn: () =>
        client.warm({
          tenantContext: tenantContext('bench-tenant'),
          connectorTypes: ['test_bench'],
        }),
    });

    // eslint-disable-next-line no-console
    console.log(formatStats('Warm baseline', baseline));
    // eslint-disable-next-line no-console
    console.log(formatStats('Warm RPC', stats));
    const { ratio } = assertLatencyRatio(stats, baseline, { ratioMax: RATIO_MAX_WARM, absP95Max: ABS_P95_MAX, absP99Max: ABS_P99_MAX }, 'Warm RPC');
    // eslint-disable-next-line no-console
    console.log(`Warm RPC/baseline p95 ratio = ${ratio.toFixed(2)}× (budget ${RATIO_MAX_WARM}×)`);
  });
});
