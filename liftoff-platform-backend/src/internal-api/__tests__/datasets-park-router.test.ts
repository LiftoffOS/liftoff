// The parking route, for the two surfaces that do not run in this process.
//
// What matters here is the door, not the rule behind it (datasets/park.test.ts
// owns that): who may knock, what shape the body may take, what comes back in
// the two shapes, and — on its own mount with its own limit — that a payload
// past the limit is refused with a 413 the caller can act on rather than
// silently accepted.

import express from 'express';
import request from 'supertest';

const mockCreateDataset = jest.fn();
jest.mock('../../datasets/store', () => ({
  ...jest.requireActual('../../datasets/store'),
  createDataset: (...args: unknown[]) => mockCreateDataset(...args),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { datasetsParkInternalRouter, PARK_BODY_LIMIT } from '../datasets-park-router';
import { TOOL_RESULT_PARK_CHARS } from '../../datasets/park';

const app = express();
app.use('/api/internal/datasets/park', express.json({ limit: PARK_BODY_LIMIT }), datasetsParkInternalRouter);

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const DATASET_ID = '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11';
const RUNTIME_TOKEN = 'runtime-token-value';
const WORKFORCE_TOKEN = 'workforce-token-value';

const base = {
  tenantId: TENANT,
  scopeKind: 'agent_run',
  scopeId: 'invocation-1',
  label: 'github_list_issues result',
  source: 'agent_tool',
  sourceRef: 'github__list_issues',
};

const oversized = 'x'.repeat(TOOL_RESULT_PARK_CHARS + 1);

function stored(recordCount: number) {
  return { id: DATASET_ID, recordCount, added: recordCount, truncated: false, fields: [{ name: 'value', type: 'text', present: 1 }], run: 1 };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TENANT_RUNTIME_SERVICE_TOKEN = RUNTIME_TOKEN;
  process.env.WORKFORCE_SERVICE_TOKEN = WORKFORCE_TOKEN;
});

afterAll(() => {
  delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
  delete process.env.WORKFORCE_SERVICE_TOKEN;
});

describe('who may park', () => {
  it('refuses a request with no service token', async () => {
    const res = await request(app).post('/api/internal/datasets/park').send({ ...base, text: oversized });
    expect(res.status).toBe(401);
  });

  it('refuses a wrong service token', async () => {
    const res = await request(app).post('/api/internal/datasets/park')
      .set('X-Service-Auth', 'not-the-token')
      .send({ ...base, text: oversized });
    expect(res.status).toBe(401);
  });

  it('accepts either of its two consumers', async () => {
    mockCreateDataset.mockResolvedValue(stored(1));
    for (const token of [RUNTIME_TOKEN, WORKFORCE_TOKEN]) {
      const res = await request(app).post('/api/internal/datasets/park')
        .set('X-Service-Auth', token)
        .send({ ...base, text: oversized });
      expect(res.status).toBe(200);
    }
  });
});

describe('the two body shapes', () => {
  it('parks a bare text result and answers with the view', async () => {
    mockCreateDataset.mockResolvedValueOnce(stored(2));
    const res = await request(app).post('/api/internal/datasets/park')
      .set('X-Service-Auth', WORKFORCE_TOKEN)
      .send({ ...base, scopeKind: 'caio_thread', scopeId: 'thread-9', text: oversized, payload: [{ a: 1 }, { a: 2 }] });

    expect(res.status).toBe(200);
    expect(res.body.text).toContain(DATASET_ID);
    expect(mockCreateDataset).toHaveBeenCalledWith(TENANT, expect.objectContaining({
      scope: { kind: 'caio_thread', id: 'thread-9' },
      records: [{ a: 1 }, { a: 2 }],
    }));
  });

  it('parks the oversized text blocks of an MCP envelope and keeps the rest of it', async () => {
    mockCreateDataset.mockResolvedValueOnce(stored(1));
    const res = await request(app).post('/api/internal/datasets/park')
      .set('X-Service-Auth', RUNTIME_TOKEN)
      .send({
        ...base,
        result: {
          content: [{ type: 'text', text: 'small' }, { type: 'text', text: oversized }],
          isError: false,
          _meta: { 'liftoff/bounded': true },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.result._meta).toEqual({ 'liftoff/bounded': true });
    expect(res.body.result.content[0]).toEqual({ type: 'text', text: 'small' });
    expect(res.body.result.content[1].text).toContain(DATASET_ID);
    expect(res.body.parked).toEqual([{ datasetId: DATASET_ID, recordCount: 1 }]);
  });

  it('returns a bounded block rather than the payload when the store could not keep it', async () => {
    mockCreateDataset.mockResolvedValueOnce(null);
    const res = await request(app).post('/api/internal/datasets/park')
      .set('X-Service-Auth', RUNTIME_TOKEN)
      .send({ ...base, result: { content: [{ type: 'text', text: oversized }] } });

    expect(res.status).toBe(200);
    expect(res.body.result.content[0].text).not.toBe(oversized);
    expect(res.body.result.content[0].text.length).toBeLessThan(oversized.length);
  });

  it('rejects a body that names neither a result nor a text', async () => {
    const res = await request(app).post('/api/internal/datasets/park')
      .set('X-Service-Auth', RUNTIME_TOKEN)
      .send(base);
    expect(res.status).toBe(400);
  });

  it('rejects a scope kind nobody parks under', async () => {
    const res = await request(app).post('/api/internal/datasets/park')
      .set('X-Service-Auth', RUNTIME_TOKEN)
      .send({ ...base, scopeKind: 'somewhere_else', text: oversized });
    expect(res.status).toBe(400);
  });
});

// THE SHAPE A COLLECTING LOOP PRODUCES.
//
// `result` is the MCP-envelope mode and validates as an object, so an ARRAY sent
// there is refused with `Expected object, received array` and an OBJECT that is
// not an envelope validates and parks nothing. Both read to a caller as "there
// was nothing to park". A step-output offload that sends every value through
// that mode cannot park a collected array of findings at all, and the findings
// get cut to fit instead.
//
// The value mode takes either shape, and it answers with the dataset so a caller
// can point a model at it rather than infer one from the absence of a field.
describe('a bare VALUE, not an envelope', () => {
  it('parks an array and names the dataset it landed in', async () => {
    // Over TOOL_RESULT_PARK_CHARS once serialized, or the route correctly hands
    // it back whole and the test would prove nothing about parking.
    const records = Array.from({ length: 60 }, (_, i) => ({ competitor: `c${i}`, note: 'n'.repeat(1_200) }));
    expect(JSON.stringify(records).length).toBeGreaterThan(TOOL_RESULT_PARK_CHARS);
    const res = await request(app).post('/api/internal/datasets/park')
      .set('X-Service-Auth', RUNTIME_TOKEN)
      .send({ ...base, text: JSON.stringify(records), payload: records });
    expect(res.status).toBe(200);
    expect(res.body.parked).toEqual([{ datasetId: expect.any(String), recordCount: expect.any(Number) }]);
    expect(typeof res.body.text).toBe('string');
  });

  it('parks an object too, as the one record it is', async () => {
    const value = { summary: 's'.repeat(60_000), competitor: 'GetAgent' };
    const res = await request(app).post('/api/internal/datasets/park')
      .set('X-Service-Auth', RUNTIME_TOKEN)
      .send({ ...base, text: JSON.stringify(value), payload: value });
    expect(res.status).toBe(200);
    expect(res.body.parked).toHaveLength(1);
  });

  it('answers an empty parked list for a value under the bound, rather than inventing a dataset', async () => {
    const res = await request(app).post('/api/internal/datasets/park')
      .set('X-Service-Auth', RUNTIME_TOKEN)
      .send({ ...base, text: 'short', payload: { a: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.parked).toEqual([]);
    expect(res.body.text).toBe('short');
  });
});

describe('the mount', () => {
  it('states its maximum accepted payload, and it is far above the 64kb the capability router allows', () => {
    // The whole reason this is its own mount: nested under the capability
    // router's `express.json({ limit: '64kb' })`, almost every payload worth
    // parking would have come back 413.
    expect(PARK_BODY_LIMIT).toBe('8mb');
  });

  it('refuses a payload past that limit with a 413 the caller can act on', async () => {
    const res = await request(app).post('/api/internal/datasets/park')
      .set('X-Service-Auth', RUNTIME_TOKEN)
      .send({ ...base, text: 'y'.repeat(9_000_000) });
    expect(res.status).toBe(413);
  });
});
