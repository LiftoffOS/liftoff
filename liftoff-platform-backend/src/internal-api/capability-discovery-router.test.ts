// Capability-discovery internal router: auth (workforce OR tenant-runtime
// token) and the capability-first search/run wiring. The vendor-hiding and
// handle logic live in the reused capability-tools functions (tested there);
// here we prove the routes gate access and wire through correctly.

import express from 'express';
import request from 'supertest';

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../liftoff/capability-tools', () => ({
  runCapabilitySearch: jest.fn(),
  runCapability: jest.fn(),
}));
jest.mock('../datasets/tools', () => ({
  DATASET_TOOL_NAMES: ['dataset_query', 'dataset_extract', 'dataset_list'],
  runDatasetTool: jest.fn(),
}));

import { runCapabilitySearch, runCapability } from '../liftoff/capability-tools';
import { runDatasetTool } from '../datasets/tools';
import { capabilityDiscoveryInternalRouter } from './capability-discovery-router';

const mockSearch = runCapabilitySearch as jest.MockedFunction<typeof runCapabilitySearch>;
const mockRun = runCapability as jest.MockedFunction<typeof runCapability>;
const mockDatasetTool = runDatasetTool as jest.MockedFunction<typeof runDatasetTool>;

const WF = 'workforce-token-under-test';
const TR = 'tenant-runtime-token-under-test';
const TENANT = '11111111-1111-1111-1111-111111111111';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/capability-discovery', capabilityDiscoveryInternalRouter);
  return app;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  jest.clearAllMocks();
  saved.WORKFORCE_SERVICE_TOKEN = process.env.WORKFORCE_SERVICE_TOKEN;
  saved.TENANT_RUNTIME_SERVICE_TOKEN = process.env.TENANT_RUNTIME_SERVICE_TOKEN;
  process.env.WORKFORCE_SERVICE_TOKEN = WF;
  process.env.TENANT_RUNTIME_SERVICE_TOKEN = TR;
});
afterEach(() => {
  process.env.WORKFORCE_SERVICE_TOKEN = saved.WORKFORCE_SERVICE_TOKEN;
  process.env.TENANT_RUNTIME_SERVICE_TOKEN = saved.TENANT_RUNTIME_SERVICE_TOKEN;
});

describe('capability-discovery internal router', () => {
  it('rejects a missing or wrong service token', async () => {
    const app = buildApp();
    await request(app).post('/api/internal/capability-discovery').send({}).expect(401);
    await request(app).post('/api/internal/capability-discovery').set('x-service-auth', 'nope').send({}).expect(401);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('search: accepts the workforce token and returns the capability-first rendering', async () => {
    mockSearch.mockResolvedValue('Ranked building blocks:\n- [Social media data] tiktok fetch (capabilityId: cap_x)');
    const res = await request(buildApp())
      .post('/api/internal/capability-discovery')
      .set('x-service-auth', WF)
      .send({ tenantId: TENANT, operation: 'fetch', entity: 'posts', mode: 'public_data' })
      .expect(200);
    expect(mockSearch).toHaveBeenCalledWith(TENANT, expect.objectContaining({ operation: 'fetch', entity: 'posts', mode: 'public_data' }), undefined);
    expect(res.body.result).toContain('capabilityId: cap_x');
    expect(res.body.result.toLowerCase()).not.toContain('tikhub');
  });

  // The account of the person behind the search rides to the search the way
  // it rides to the run, so the vendors are judged on the credentials that
  // run would use. Supplied by the calling service, never by a model.
  it('search: threads the caller-supplied accountId through, and keeps it out of the spec', async () => {
    mockSearch.mockResolvedValue('ok');
    await request(buildApp())
      .post('/api/internal/capability-discovery')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, accountId: 'acct-1', operation: 'fetch', entity: 'posts', mode: 'public_data' })
      .expect(200);
    expect(mockSearch).toHaveBeenCalledWith(TENANT, { operation: 'fetch', entity: 'posts', mode: 'public_data' }, 'acct-1');
  });

  it('run: accepts the tenant-runtime token and resolves a capabilityId as the agent caller', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: '{"items":[{"a":1}]}' });
    const res = await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, accountId: 'acct-1', capabilityId: 'cap_abc', args: { q: 'x' } })
      .expect(200);
    expect(mockRun).toHaveBeenCalledWith(TENANT, 'acct-1', { capabilityId: 'cap_abc', args: { q: 'x' } }, { caller: 'agent', approved: false, scope: { kind: 'unscoped', id: '' } });
    expect(res.body.result).toBe('{"items":[{"a":1}]}');
    expect(res.body.outcome).toEqual({ ok: true, empty: false });
  });

  it('run: accepts an omitted accountId (autonomous agent, platform-funded)', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'ok' });
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, capabilityId: 'cap_abc', args: {} })
      .expect(200);
    expect(mockRun).toHaveBeenCalledWith(TENANT, '', { capabilityId: 'cap_abc', args: {} }, { caller: 'agent', approved: false, scope: { kind: 'unscoped', id: '' } });
  });

  it('run: threads approved=true through ONLY for the agent (tenant-runtime) caller', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'done' });
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, capabilityId: 'cap_abc', args: {}, approved: true })
      .expect(200);
    expect(mockRun).toHaveBeenCalledWith(TENANT, '', { capabilityId: 'cap_abc', args: {} }, { caller: 'agent', approved: true, scope: { kind: 'unscoped', id: '' } });
  });

  it('run: the CAIO caller is read-only — an approved flag is dropped, never trusted', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'nope' });
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', WF)
      .send({ tenantId: TENANT, capabilityId: 'cap_abc', args: {}, approved: true })
      .expect(200);
    expect(mockRun).toHaveBeenCalledWith(TENANT, '', { capabilityId: 'cap_abc', args: {} }, { caller: 'caio', approved: false, scope: { kind: 'unscoped', id: '' } });
  });

  it('rejects a malformed search body', async () => {
    await request(buildApp())
      .post('/api/internal/capability-discovery')
      .set('x-service-auth', WF)
      .send({ tenantId: TENANT }) // missing operation/entity/mode
      .expect(400);
  });
});

// The wire carries the status beside the text. A refusal rendered as text used
// to be indistinguishable from a result; `outcome` is what lets the runtime
// report a failed tool call instead of a success that sent nothing. The reason
// stays in this service's logs — it can name a vendor.
describe('run: the outcome travels with the text', () => {
  it('a refused run is result + outcome:{ok:false, kind}', async () => {
    mockRun.mockResolvedValue({ ok: false, kind: 'refused', text: 'This capability did not return a result.' });
    const res = await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, accountId: 'acct-1', capabilityId: 'cap_w.abc', args: { to: 'x@y.com' }, approved: true })
      .expect(200);
    expect(res.body).toEqual({ result: 'This capability did not return a result.', outcome: { ok: false, kind: 'refused' } });
    expect(JSON.stringify(res.body)).not.toContain('reason');
  });

  // "Ran" is not "answered": a run that happened and returned nothing usable
  // is ok with empty:true, so a caller counting useful results can tell.
  it('a run that answered nothing is result + outcome:{ok:true, empty:true}', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: true, text: 'This capability did not return a result.' });
    const res = await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, capabilityId: 'cap_r.abc', args: {} })
      .expect(200);
    expect(res.body.outcome).toEqual({ ok: true, empty: true });
  });

  it('a handoff travels as kind handoff with its text, which names the next handle', async () => {
    mockRun.mockResolvedValue({ ok: false, kind: 'handoff', text: 'The next best for the same need takes: q (string, required); call run_capability with capabilityId cap_r.next' });
    const res = await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, capabilityId: 'cap_r.abc', args: {} })
      .expect(200);
    expect(res.body.outcome).toEqual({ ok: false, kind: 'handoff' });
    expect(res.body.result).toContain('cap_r.next');
  });

  it('accepts the arguments under `arguments` too, as an object or a JSON string', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'ok' });
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, capabilityId: 'cap_abc', arguments: JSON.stringify({ q: 'x' }) })
      .expect(200);
    expect(mockRun).toHaveBeenCalledWith(TENANT, '', expect.objectContaining({ capabilityId: 'cap_abc', arguments: JSON.stringify({ q: 'x' }) }), expect.anything());
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, capabilityId: 'cap_abc', arguments: { q: 'y' } })
      .expect(200);
  });

  it('forwards the caller\'s idempotency key, and refuses one that could not be a key', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'ok' });
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, capabilityId: 'cap_w.abc', args: { to: 'x@y.com' }, approved: true, idempotencyKey: 'cap:6ebe2b95:0123456789ab:deadbeefdeadbeef' })
      .expect(200);
    expect(mockRun).toHaveBeenLastCalledWith(
      TENANT, '', expect.anything(), expect.objectContaining({ idempotencyKey: 'cap:6ebe2b95:0123456789ab:deadbeefdeadbeef' }),
    );
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, capabilityId: 'cap_w.abc', args: {}, idempotencyKey: 'has spaces; and punctuation!' })
      .expect(400);
  });
});

// A large result is parked for the JOB the caller names, and the dataset
// tools read it back for the same job.
describe('the job a run belongs to, and its datasets', () => {
  it('run: the scope and appendTo the caller names reach runCapability', async () => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: 'ok' });
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, capabilityId: 'cap_abc', args: {}, scopeKind: 'agent_run', scopeId: 'inv-7', appendTo: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11' })
      .expect(200);
    expect(mockRun).toHaveBeenCalledWith(
      TENANT, '', { capabilityId: 'cap_abc', args: {}, appendTo: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11' },
      { caller: 'agent', approved: false, scope: { kind: 'agent_run', id: 'inv-7' } },
    );
  });

  it('run: a body with no capabilityId is refused', async () => {
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, args: {} })
      .expect(400);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('datasets/tool: runs the named tool for the job, under the caller\'s purpose', async () => {
    mockDatasetTool.mockResolvedValue('rows…');
    const res = await request(buildApp())
      .post('/api/internal/capability-discovery/datasets/tool')
      .set('x-service-auth', WF)
      .send({ tenantId: TENANT, tool: 'dataset_query', input: { datasetId: 'x', select: ['title'] }, scopeKind: 'caio_thread', scopeId: 'th-1' })
      .expect(200);
    expect(res.body).toEqual({ result: 'rows…' });
    expect(mockDatasetTool).toHaveBeenCalledWith(TENANT, 'dataset_query', { datasetId: 'x', select: ['title'] }, { scope: { kind: 'caio_thread', id: 'th-1' }, purpose: 'caio_dataset_extract' });

    await request(buildApp())
      .post('/api/internal/capability-discovery/datasets/tool')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, tool: 'dataset_list' })
      .expect(200);
    expect(mockDatasetTool).toHaveBeenLastCalledWith(TENANT, 'dataset_list', {}, { scope: { kind: 'unscoped', id: '' }, purpose: 'agent_dataset_extract' });
  });

  it('datasets/tool: refuses a tool that is not one of the three, and a missing token', async () => {
    await request(buildApp())
      .post('/api/internal/capability-discovery/datasets/tool')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, tool: 'dataset_drop', input: {} })
      .expect(400);
    await request(buildApp())
      .post('/api/internal/capability-discovery/datasets/tool')
      .send({ tenantId: TENANT, tool: 'dataset_list' })
      .expect(401);
    expect(mockDatasetTool).not.toHaveBeenCalled();
  });
});

// ── Which agent a capability run is booked to ──────────────────────────
//
// The request carried no agent, so the cost row this run books had neither an
// agent id nor a surface and the Cost Breakdown reported the spend as
// "Unattributed".
//
// The field is `internalAgentId`, matching what the tenant runtime emits on
// anything sent to the control plane (INV-TR-010): the two id spaces are
// disjoint and the NAME is what says which one a value holds.
describe('internalAgentId on /run', () => {
  const AGENT = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    mockRun.mockResolvedValue({ ok: true, empty: false, text: '{}' });
  });

  it('is forwarded for the agent caller', async () => {
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, accountId: 'acct-1', capabilityId: 'cap_abc', args: {}, internalAgentId: AGENT })
      .expect(200);
    expect(mockRun).toHaveBeenCalledWith(
      TENANT, 'acct-1', expect.anything(),
      expect.objectContaining({ agentId: AGENT }),
    );
  });

  it('is optional: a run without one still executes and books unattributed', async () => {
    // The runtime omits it when its reverse mapping misses. The capability has
    // to run anyway — attribution is not worth failing a tool call for.
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, accountId: 'acct-1', capabilityId: 'cap_abc', args: {} })
      .expect(200);
    const opts = mockRun.mock.calls[0][3] as Record<string, unknown>;
    expect(opts.agentId).toBeUndefined();
  });

  it('rejects a non-uuid rather than letting it reach the ledger', async () => {
    await request(buildApp())
      .post('/api/internal/capability-discovery/run')
      .set('x-service-auth', TR)
      .send({ tenantId: TENANT, capabilityId: 'cap_abc', args: {}, internalAgentId: 'not-a-uuid' })
      .expect(400);
  });
});
