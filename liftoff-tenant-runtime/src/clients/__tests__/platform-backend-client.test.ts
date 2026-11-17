import { jest } from '@jest/globals';

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { listCanonicalAgents, runCapabilityViaBackend } from '../platform-backend-client';

const realFetch = global.fetch;

beforeEach(() => {
  delete process.env.PLATFORM_BACKEND_URL;
  delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.PLATFORM_BACKEND_URL;
  delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
});

describe('platform-backend-client.listCanonicalAgents', () => {
  it('returns parsed agents on 2xx', async () => {
    process.env.PLATFORM_BACKEND_URL = 'https://pb.example';
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'tok';
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        agents: [{
          id: 'a1', role: 'r', messagingNickname: null,
          status: 'active', currentVersion: 1,
          triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *' },
          integrations: [],
        }],
      }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const out = await listCanonicalAgents('11111111-1111-1111-1111-111111111111');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a1');
    const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(callArgs[0]).toContain('tenantId=11111111-1111-1111-1111-111111111111');
    expect((callArgs[1].headers as Record<string, string>)['X-Service-Auth']).toBe('tok');
  });

  it('throws on 5xx', async () => {
    process.env.PLATFORM_BACKEND_URL = 'https://pb.example';
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'tok';
    global.fetch = (async () => ({
      ok: false, status: 500, text: async () => 'boom',
    })) as unknown as typeof fetch;
    await expect(listCanonicalAgents('00000000-0000-0000-0000-000000000001')).rejects.toThrow(/HTTP 500/);
  });

  it('propagates AbortError on timeout', async () => {
    process.env.PLATFORM_BACKEND_URL = 'https://pb.example';
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'tok';
    global.fetch = (async () => {
      const err = new Error('aborted');
      (err as Error & { name: string }).name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;
    await expect(listCanonicalAgents('00000000-0000-0000-0000-000000000001')).rejects.toThrow();
  });

  it('throws when PLATFORM_BACKEND_URL missing', async () => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'tok';
    await expect(listCanonicalAgents('00000000-0000-0000-0000-000000000001'))
      .rejects.toThrow(/PLATFORM_BACKEND_URL/);
  });

  it('throws when TENANT_RUNTIME_SERVICE_TOKEN missing', async () => {
    process.env.PLATFORM_BACKEND_URL = 'https://pb.example';
    await expect(listCanonicalAgents('00000000-0000-0000-0000-000000000001'))
      .rejects.toThrow(/TENANT_RUNTIME_SERVICE_TOKEN/);
  });

  // Regression test for the deferred-secrets bug: module imports happen BEFORE
  // loadSecretsToEnv() runs at boot. If the client captured env vars at import
  // time, this test would fail because the import (above) loaded the module
  // when envs were unset, and subsequent setting wouldn't take effect.
  it('reads env vars lazily — works even when envs are set AFTER first import', async () => {
    // The module was already imported (top of file) when envs were empty.
    // Set them now and confirm the call uses the current values.
    process.env.PLATFORM_BACKEND_URL = 'https://pb-late.example';
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'late-tok';
    const fetchMock = jest.fn(async () => ({
      ok: true, status: 200, json: async () => ({ agents: [] }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await listCanonicalAgents('11111111-1111-1111-1111-111111111111');
    const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(callArgs[0]).toMatch(/^https:\/\/pb-late\.example/);
    expect((callArgs[1].headers as Record<string, string>)['X-Service-Auth']).toBe('late-tok');
  });
});

// The run route carries a typed `outcome` beside the model-facing `result`.
// A response without one predates the field and was always a success; a
// response with `ok: false` is the truth that the capability did not run.
describe('platform-backend-client.runCapabilityViaBackend', () => {
  function respond(body: unknown) {
    process.env.PLATFORM_BACKEND_URL = 'https://pb.example';
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'tok';
    global.fetch = (async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' })) as unknown as typeof fetch;
  }

  it('treats a legacy response (result only) as a successful run', async () => {
    respond({ result: 'Message sent' });
    await expect(runCapabilityViaBackend('t1', 'acct', 'cap_w.x', { to: 'a@b' }, true)).resolves.toEqual({ ok: true, empty: false, text: 'Message sent' });
  });

  it('surfaces a refused run as ok:false with its kind and the neutral text', async () => {
    respond({ result: 'This capability did not return a result.', outcome: { ok: false, kind: 'refused' } });
    await expect(runCapabilityViaBackend('t1', 'acct', 'cap_w.x', {}, true)).resolves.toEqual({
      ok: false, kind: 'refused', text: 'This capability did not return a result.',
    });
  });

  it('defaults an unlabelled failure to no_result', async () => {
    respond({ result: 'nothing', outcome: { ok: false } });
    await expect(runCapabilityViaBackend('t1', undefined, 'cap_r.x', {}, false)).resolves.toMatchObject({ ok: false, kind: 'no_result' });
  });

  it('an explicit ok:true outcome is a success', async () => {
    respond({ result: 'done', outcome: { ok: true } });
    await expect(runCapabilityViaBackend('t1', 'acct', 'cap_w.x', {}, true)).resolves.toEqual({ ok: true, empty: false, text: 'done' });
  });

  // "Ran" is not "answered": the flag says the source ran and returned
  // nothing usable, which a step counting useful results must not count.
  it('carries empty:true on a run that answered nothing', async () => {
    respond({ result: 'This capability did not return a result.', outcome: { ok: true, empty: true } });
    await expect(runCapabilityViaBackend('t1', undefined, 'cap_r.x', {}, false)).resolves.toEqual({
      ok: true, empty: true, text: 'This capability did not return a result.',
    });
  });

  it('carries a handoff as ok:false with kind handoff and the text naming the next handle', async () => {
    respond({ result: 'The next best for the same need takes: q (string, required); call run_capability with capabilityId cap_r.next', outcome: { ok: false, kind: 'handoff' } });
    await expect(runCapabilityViaBackend('t1', undefined, 'cap_r.x', { q: 'x' }, false)).resolves.toEqual({
      ok: false, kind: 'handoff', text: expect.stringContaining('cap_r.next'),
    });
  });

  it('carries the ledger\'s idempotency key in the body, and omits the field when there is none', async () => {
    const bodies: Record<string, unknown>[] = [];
    process.env.PLATFORM_BACKEND_URL = 'https://pb.example';
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'tok';
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ result: 'ok' }), text: async () => '' };
    }) as unknown as typeof fetch;
    await runCapabilityViaBackend('t1', 'acct', 'cap_w.x', { to: 'a@b' }, true, 'cap:inv:op:args');
    await runCapabilityViaBackend('t1', 'acct', 'cap_w.x', { to: 'a@b' }, true);
    expect(bodies[0]).toMatchObject({ idempotencyKey: 'cap:inv:op:args', approved: true });
    expect(bodies[1]).not.toHaveProperty('idempotencyKey');
  });
});
