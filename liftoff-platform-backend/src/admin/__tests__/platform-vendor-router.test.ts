// The admin surface for the four platform vendor levers.
//
// The behaviour worth pinning is the REFUSAL. A lever set to a vendor this
// plane cannot route to would read as configured on the screen and change
// nothing at all — the worst of both, because it looks like the feature works.
// Grok is the live case: it left the gateway for api.x.ai and the control plane
// holds no xAI client.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: mockQuery }),
}));

const mockPublish = jest.fn().mockResolvedValue(undefined);
jest.mock('../../events/publisher', () => ({ publishEvent: mockPublish }));

// What this environment holds a client for. Empty by default, which is the
// "cannot tell yet" case the router treats as no filter at all.
let mockAvailable: string[] = [];
jest.mock('../../llm/client', () => ({
  llmClient: { getAvailableProviders: () => mockAvailable },
}));

const mockAudit = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: mockAudit,
}));

import express from 'express';
import request from 'supertest';
import { platformVendorRouter } from '../platform-vendor-router';
import {
  _resetPlatformVendorPolicy,
  platformVendorForArea,
} from '../../model-registry/platform-vendor-policy';

function makeApp(uid = 'admin-1') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: { uid: string } }).user = { uid };
    next();
  });
  app.use('/api/admin/platform-vendors', platformVendorRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAvailable = [];
  _resetPlatformVendorPolicy();
  // The loader's re-read after a write.
  mockQuery.mockResolvedValue({ rows: [] });
});
afterEach(() => _resetPlatformVendorPolicy());

describe('GET /api/admin/platform-vendors', () => {
  it('lists all four areas with what each may be set to', async () => {
    const res = await request(makeApp()).get('/api/admin/platform-vendors');
    expect(res.status).toBe(200);
    // Sorted on both sides. The expected list used to be written in the order
    // the old name happened to sort into, which quietly depended on the word
    // rather than on the set.
    expect(res.body.areas.map((a: { area: string }) => a.area).sort()).toEqual([
      'agent_shaping', 'assistants', 'quiet_work', 'safety',
    ]);
    // Every area describes itself, so the screen does not restate them.
    for (const a of res.body.areas) expect(a.description).toBeTruthy();
  });

  it('offers no vendor it cannot route to', async () => {
    const res = await request(makeApp()).get('/api/admin/platform-vendors');
    expect(res.body.selectableVendors).toContain('qwen');
    expect(res.body.selectableVendors).toContain('default');
    expect(res.body.selectableVendors).not.toContain('grok');
  });

  it('says what each lever RESOLVES to, not only what it was set to', async () => {
    const res = await request(makeApp()).get('/api/admin/platform-vendors');
    // On the default, a lever resolves to nothing — which is how the screen can
    // tell "set to default" from "set to something that does not work".
    for (const a of res.body.areas) expect(a.resolves).toBeNull();
  });
});

describe('PUT /api/admin/platform-vendors', () => {
  it('moves a lever, publishes, and audits the actor', async () => {
    mockQuery.mockResolvedValue({ rows: [{ area: 'quiet_work', vendor: 'qwen' }] });
    const res = await request(makeApp('admin-7'))
      .put('/api/admin/platform-vendors')
      .send({ areas: { quiet_work: 'qwen' } });
    expect(res.status).toBe(200);
    expect(platformVendorForArea('quiet_work')).toBe('qwen');

    // The other plane has to be told, or the lever is only eventually fast.
    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'platform.vendor_policy.updated', tenantId: null }),
    );
    // A runtime-mutable routing change with no actor is unaccountable.
    expect(mockAudit).toHaveBeenCalledWith(
      'platform_vendor_policy.updated',
      { adminId: 'admin-7' },
      expect.objectContaining({ area: 'quiet_work', to: 'qwen' }),
    );
  });

  it('REFUSES a vendor this plane cannot route to, and writes nothing', async () => {
    const res = await request(makeApp())
      .put('/api/admin/platform-vendors')
      .send({ areas: { assistants: 'grok' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('vendor_not_routable');
    expect(res.body.rejected).toEqual([{ area: 'assistants', vendor: 'grok' }]);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('refuses an unknown vendor outright', async () => {
    const res = await request(makeApp())
      .put('/api/admin/platform-vendors')
      .send({ areas: { safety: 'not-a-vendor' } });
    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses an unknown area', async () => {
    const res = await request(makeApp())
      .put('/api/admin/platform-vendors')
      .send({ areas: { not_an_area: 'qwen' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  it('refuses an empty change', async () => {
    const res = await request(makeApp())
      .put('/api/admin/platform-vendors')
      .send({ areas: {} });
    expect(res.status).toBe(400);
  });

  it('does not publish when the write fails', async () => {
    // A push saying "read it again" when nothing changed would have both planes
    // re-read to the same value and report a change that did not happen.
    mockQuery.mockRejectedValue(new Error('connection terminated'));
    const res = await request(makeApp())
      .put('/api/admin/platform-vendors')
      .send({ areas: { quiet_work: 'qwen' } });
    expect(res.status).toBe(500);
    expect(mockPublish).not.toHaveBeenCalled();
  });
});

describe('a vendor that is routable but not configured HERE', () => {
  // Routable and inert are different failures with the same symptom. A gateway
  // vendor with no OpenRouter key in this environment resolves perfectly well
  // and then never runs: the LLM client keeps the default and says so in a log.
  // The edit is the only place an operator can be told.
  it('is not offered', async () => {
    mockAvailable = ['anthropic', 'openai'];
    const res = await request(makeApp()).get('/api/admin/platform-vendors');
    expect(res.body.selectableVendors).toContain('anthropic');
    expect(res.body.selectableVendors).not.toContain('qwen');
    expect(res.body.availableProviders).toEqual(['anthropic', 'openai']);
  });

  it('is refused, and the refusal says which providers exist', async () => {
    mockAvailable = ['anthropic'];
    const res = await request(makeApp())
      .put('/api/admin/platform-vendors')
      .send({ areas: { quiet_work: 'qwen' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('vendor_not_routable');
    expect(res.body.availableProviders).toEqual(['anthropic']);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('still offers everything routable when availability is not yet known', async () => {
    // A cold process reports no providers. Refusing every vendor then would
    // make the screen unusable for the one reason that is never the operator's
    // fault.
    mockAvailable = [];
    const res = await request(makeApp()).get('/api/admin/platform-vendors');
    expect(res.body.selectableVendors).toContain('qwen');
  });
});

describe('GET /api/admin/platform-vendors/resolve/:purpose', () => {
  it('answers which area a purpose lands in and what it resolves to', async () => {
    const res = await request(makeApp()).get('/api/admin/platform-vendors/resolve/dlp_deep_scan');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ purpose: 'dlp_deep_scan', area: 'safety', vendor: 'default' }),
    );
  });

  it('answers for an unregistered purpose too, so the default is visible', async () => {
    const res = await request(makeApp()).get('/api/admin/platform-vendors/resolve/brand_new_thing');
    expect(res.body.area).toBe('quiet_work');
  });
});
