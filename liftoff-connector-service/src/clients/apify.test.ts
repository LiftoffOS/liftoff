// The Apify native executor is the workspace's-own-account rung: it refuses
// without the workspace's key (the platform's rungs live elsewhere), runs an
// actor by id with every cap on the start call, follows THAT run to a
// terminal status, reads its dataset and its settled cost, and reports the
// call as tenant_key so nothing here is charged to the workspace in OUs.

import type { ExecutorContext } from '../rpc/execute-dispatcher.js';

const calls: Array<{ url: string; init?: RequestInit }> = [];
let script: Array<{ status: number; body: unknown }> = [];
jest.mock('./connector-transport.js', () => ({
  DEFAULT_PUBLIC_WEB_HEADERS: { Accept: 'application/json' },
  makePublicWebTransport: (_type: string, headers: Record<string, string>) => async (req: { method: string; url: string; query?: Record<string, string>; body?: unknown }) => {
    const u = new URL(req.url);
    for (const [k, v] of Object.entries(req.query ?? {})) u.searchParams.set(k, v);
    calls.push({ url: u.toString(), init: { method: req.method, headers, body: req.body === undefined ? undefined : JSON.stringify(req.body) } });
    const next = script.shift() ?? { status: 500, body: { error: { type: 'unscripted', message: 'no answer scripted' } } };
    return { ok: next.status < 400, status: next.status, json: async () => next.body } as unknown as Response;
  },
}));
jest.mock('../infra/logging.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { apifyExecutor } from './apify.js';

function ctx(functionName: string, input: Record<string, unknown>, over: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    tenantId: 't-1', connectorId: 'conn-9', connectorType: 'apify', connectorConfig: {},
    functionName, input: input as ExecutorContext['input'], idempotencyKey: 'idem-1', traceId: 'tr',
    credentials: { flowKind: 'api_key', apiKey: 'apify_api_theirs' },
    ...over,
  } as ExecutorContext;
}

beforeEach(() => { calls.length = 0; script = []; });

it('refuses without the workspace\'s own key, and never pays from a platform credential', async () => {
  const internal = await apifyExecutor(ctx('run_actor', { actorId: 'a/b', input: {} }, { connectorId: 'internal:apify' }));
  expect(internal.failure?.message).toContain('no connected Apify account');
  const none = await apifyExecutor(ctx('run_actor', { actorId: 'a/b', input: {} }, { credentials: { flowKind: 'api_key' } }));
  expect(none.failure?.message).toContain('no connected Apify account');
  expect(calls).toHaveLength(0);
});

it('runs an actor with every cap on the start call, follows the run, reads its dataset and settled cost, and reports tenant_key', async () => {
  script = [
    { status: 201, body: { data: { id: 'run-1', status: 'RUNNING', defaultDatasetId: 'ds-1' } } },
    { status: 200, body: { data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'ds-1', usageTotalUsd: 0.0005, pricingInfo: { pricingModel: 'PAY_PER_EVENT' } } } },
    { status: 200, body: [{ a: 1 }, { a: 2 }] },
    { status: 200, body: { data: { id: 'run-1', status: 'SUCCEEDED', usageTotalUsd: 0.0105, chargedEventCounts: { 'apify-actor-start': 1, 'result': 2 } } } },
  ];
  const out = await apifyExecutor(ctx('run_actor', { actorId: 'clockworks/tiktok-scraper', input: { hashtags: ['shopify'] }, maxItems: 3 }));
  expect(out.failure).toBeUndefined();
  expect(out.fundingSource).toBe('tenant_key');
  expect(out.costUsd).toBeCloseTo(0.0105, 9);
  expect(out.result).toEqual({ runId: 'run-1', datasetId: 'ds-1', items: [{ a: 1 }, { a: 2 }] });

  const start = new URL(calls[0].url);
  expect(start.pathname).toBe('/v2/acts/clockworks~tiktok-scraper/runs');
  expect(Object.fromEntries(start.searchParams)).toEqual({ timeout: '90', memory: '1024', waitForFinish: '60', maxItems: '3', maxTotalChargeUsd: '1' });
  expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer apify_api_theirs');
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ hashtags: ['shopify'] });
  expect(calls[1].url).toContain('/v2/actor-runs/run-1?waitForFinish=');
  expect(calls[2].url).toContain('/v2/actor-runs/run-1/dataset/items?limit=3&format=json');
});

it('reports a refused start as the vendor\'s own account of it, with no run', async () => {
  script = [{ status: 400, body: { error: { type: 'invalid-input', message: 'Field hashtags must be array' } } }];
  const out = await apifyExecutor(ctx('run_actor', { actorId: 'a/b', input: { hashtags: 'x' } }));
  expect(out.failure?.message).toBe('apify refused the run: invalid-input: Field hashtags must be array');
  expect(out.result).not.toHaveProperty('runId');
});

it('a run that failed still carries its id and the charge the vendor reported', async () => {
  script = [{ status: 201, body: { data: { id: 'run-2', status: 'FAILED', statusMessage: 'Actor crashed', usageTotalUsd: 0.0007 } } }];
  const out = await apifyExecutor(ctx('run_actor', { actorId: 'a/b', input: {} }));
  expect(out.failure?.message).toContain('ended FAILED: Actor crashed');
  expect(out.result).toMatchObject({ runId: 'run-2' });
  expect(out.costUsd).toBe(0.0007);
  expect(out.fundingSource).toBe('tenant_key');
});

it('reads a dataset, an actor and the run list on the account', async () => {
  script = [{ status: 200, body: [{ x: 1 }] }];
  expect((await apifyExecutor(ctx('get_dataset_items', { datasetId: 'ds-1', limit: 5 }))).result).toEqual({ items: [{ x: 1 }] });
  expect(calls[0].url).toContain('/v2/datasets/ds-1/items?limit=5&offset=0&format=json');

  script = [{ status: 200, body: { data: { id: 'act-1', name: 'b', pricingInfos: [{ pricingModel: 'PAY_PER_EVENT' }] } } }];
  expect((await apifyExecutor(ctx('get_actor', { actorId: 'a/b' }))).result).toMatchObject({ id: 'act-1' });
  expect(calls[1].url).toContain('/v2/acts/a~b');

  script = [{ status: 200, body: { data: { items: [{ id: 'run-1' }], total: 1 } } }];
  expect((await apifyExecutor(ctx('list_runs', { limit: 5, status: 'succeeded' }))).result).toMatchObject({ items: [{ id: 'run-1' }] });
  expect(calls[2].url).toContain('/v2/actor-runs?limit=5&desc=1&status=SUCCEEDED');
});

it('names an unknown tool', async () => {
  expect((await apifyExecutor(ctx('delete_everything', {}))).failure?.message).toContain('no tool named');
});
