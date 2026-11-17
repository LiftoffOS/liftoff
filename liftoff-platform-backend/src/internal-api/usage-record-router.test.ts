// POST /api/internal/usage/record: the registry validation, the fixed
// purpose, the bounds, the idempotent insert, and the classification of a
// row with no agent id as customer usage.

import express from 'express';

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockWrite = jest.fn();
jest.mock('../llm/usage-tracker', () => ({ writeUsageEvent: (...a: unknown[]) => mockWrite(...a) }));

import { usageRecordRouter, _setRegistryLookupForTesting, purposeFor } from './usage-record-router';
import { classifyChargeability } from '../cost-attribution/event-classification';
import { TYPESAFE_MODEL } from '../typesafe/questions';

const TOKEN = 'platform-callback-token-under-test';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const CALL_ID = '33333333-3333-4333-8333-333333333333';

function buildApp() {
  const app = express();
  app.use('/api/internal/usage/record', express.json(), usageRecordRouter);
  return app;
}
function post(app: express.Express, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/usage/record`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-service-auth': token } : {}) },
        body: JSON.stringify(body),
      })
        .then(async (res) => { const b = await res.json().catch(() => ({})); server.close(); resolve({ status: res.status, body: b as Record<string, unknown> }); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

const STAGEHAND = { callId: CALL_ID, attempts: 1, provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 20, tenantId: TENANT_ID };
const JEV = { callId: CALL_ID, attempts: 1, provider: 'typesafe', model: TYPESAFE_MODEL, inputTokens: 5000, outputTokens: 0, tenantId: TENANT_ID, setId: 'browser_step' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  mockWrite.mockResolvedValue(undefined);
  _setRegistryLookupForTesting(async (provider, model) => provider === 'anthropic' && model === 'claude-sonnet-4-6');
});
afterAll(() => _setRegistryLookupForTesting(null));

describe('POST /api/internal/usage/record', () => {
  it('rejects a missing or wrong token', async () => {
    const app = buildApp();
    expect((await post(app, STAGEHAND)).status).toBe(401);
    expect((await post(app, STAGEHAND, 'nope')).status).toBe(401);
  });

  it('records a Stagehand request with purpose browser_task, ignoring a supplied purpose', async () => {
    const r = await post(buildApp(), { ...STAGEHAND, purpose: 'agent_chat' }, TOKEN);
    expect(r.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 20, callId: CALL_ID, attempts: 1,
      context: { tenantId: TENANT_ID, purpose: 'browser_task' },
    }));
  });

  it('rejects an unregistered provider or model', async () => {
    const app = buildApp();
    expect((await post(app, { ...STAGEHAND, model: 'claude-nope' }, TOKEN)).status).toBe(400);
    expect((await post(app, { ...STAGEHAND, provider: 'martian' }, TOKEN)).status).toBe(400);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('maps Vertex to the Anthropic rows and xai to grok', async () => {
    _setRegistryLookupForTesting(async (provider, model) => (provider === 'anthropic' && model === 'claude-sonnet-4-6') || (provider === 'grok' && model === 'grok-4.6'));
    const app = buildApp();
    expect((await post(app, { ...STAGEHAND, provider: 'anthropic-vertex' }, TOKEN)).status).toBe(200);
    expect((await post(app, { ...STAGEHAND, provider: 'xai', model: 'grok-4.6' }, TOKEN)).status).toBe(200);
  });

  it('bounds the counts', async () => {
    const app = buildApp();
    expect((await post(app, { ...STAGEHAND, inputTokens: -1 }, TOKEN)).status).toBe(400);
    expect((await post(app, { ...STAGEHAND, outputTokens: 1.5 }, TOKEN)).status).toBe(400);
    expect((await post(app, { ...STAGEHAND, attempts: 0 }, TOKEN)).status).toBe(400);
  });

  it('typesafe: the model is validated against the pinned ids and the purpose derives from the set id', async () => {
    const app = buildApp();
    const ok = await post(app, JEV, TOKEN);
    expect(ok.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(expect.objectContaining({ provider: 'typesafe', context: { tenantId: TENANT_ID, purpose: 'browser_step' } }));
    expect((await post(app, { ...JEV, model: 'jev-latest' }, TOKEN)).status).toBe(400);
    expect((await post(app, { ...JEV, setId: 'classifier' }, TOKEN)).status).toBe(400);
    expect((await post(app, { ...JEV, setId: undefined }, TOKEN)).status).toBe(400);
    for (const setId of ['browser_goal_check', 'contract_check', 'ask_check', 'memory_save', 'memory_used', 'message_check', 'untrusted_content']) {
      expect(purposeFor({ provider: 'typesafe', setId })).toEqual({ purpose: setId });
    }
  });

  it('untrusted_content posts like any other runtime set, end to end', async () => {
    // The set id has to be in THIS repo's RUNTIME_SET_IDS as well as the
    // runtime's own copy. A one-sided addition is a 400 here, which makes the
    // runtime's post fail, which makes `ask` return null — and the semantic
    // screen is then off with nothing saying so.
    const app = buildApp();
    const res = await post(app, { ...JEV, setId: 'untrusted_content' }, TOKEN);
    expect(res.status).toBe(200);
    expect(mockWrite).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'typesafe',
      context: { tenantId: TENANT_ID, purpose: 'untrusted_content' },
    }));
  });

  it('inserts idempotently on callId: the write carries the id, and a second POST is one row', async () => {
    const app = buildApp();
    await post(app, JEV, TOKEN);
    await post(app, JEV, TOKEN);
    expect(mockWrite).toHaveBeenCalledTimes(2);
    for (const call of mockWrite.mock.calls) expect(call[0].callId).toBe(CALL_ID);
    // The writer's statement is `ON CONFLICT (call_id) WHERE call_id IS NOT NULL DO NOTHING`
    // (usage-tracker.integration.test.ts proves it against the schema).
  });

  it('classifies a row with no agent id as customer usage', async () => {
    await post(buildApp(), JEV, TOKEN);
    const event = mockWrite.mock.calls[0][0];
    expect(event.context.agentId).toBeUndefined();
    expect(classifyChargeability({ source: 'platform_llm', purpose: event.context.purpose, agentId: null })).toBe('customer');
  });
});
