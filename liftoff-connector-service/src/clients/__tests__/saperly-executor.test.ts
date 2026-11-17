// Saperly REST executor: dispatch fidelity (path/method/params), BYO-only
// credential, path-param substitution, and typed failures. Vendor traffic is
// mocked — no network.

import type { ExecutorContext } from '../../rpc/execute-dispatcher.js';
import { saperlyExecutor } from '../saperly.js';

const originalFetch = global.fetch;

function ctx(overrides: Partial<ExecutorContext>): ExecutorContext {
  return {
    tenantId: 't-1',
    connectorId: 'conn-saperly-1',
    connectorType: 'saperly',
    connectorConfig: {},
    functionName: 'missing',
    input: {},
    idempotencyKey: 'idem-1',
    traceId: 'trace-1',
    credentials: { flowKind: 'api_key', apiKey: 'sap_sk_live_tenant' },
    ...overrides,
  } as ExecutorContext;
}

function mockFetchOnce(status: number, body: unknown): jest.Mock {
  const mock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

afterEach(() => {
  global.fetch = originalFetch;
});

describe('saperly REST executor', () => {
  it('POSTs send_sms to /messages with the tenant key as Bearer and the args as the body', async () => {
    const mock = mockFetchOnce(200, { id: 'm-1', status: 'queued' });
    const out = await saperlyExecutor(
      ctx({ functionName: 'send_sms', input: { fromNumberId: 'n-1', to: '+14155550100', body: 'hi' } }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.fundingSource).toBe('tenant_key');
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toBe('https://api.saperly.com/messages');
    expect((init as { method: string }).method).toBe('POST');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sap_sk_live_tenant');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ fromNumberId: 'n-1', to: '+14155550100', body: 'hi' });
  });

  it('substitutes a {id} path param and does NOT resend it in the body', async () => {
    const mock = mockFetchOnce(200, {});
    await saperlyExecutor(ctx({ functionName: 'release_number', input: { id: 'num-123' } }));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toBe('https://api.saperly.com/numbers/num-123/release');
    expect((init as { method: string }).method).toBe('POST');
    expect(JSON.parse((init as { body: string }).body)).toEqual({}); // id was consumed by the path
  });

  it('sends GET reads as query params, not a body (check_consent)', async () => {
    const mock = mockFetchOnce(200, { hasConsent: true });
    await saperlyExecutor(ctx({ functionName: 'check_consent', input: { numberId: 'n-1', peerNumber: '+14155550100' } }));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toContain('https://api.saperly.com/consent/check');
    expect(String(url)).toContain('numberId=n-1');
    expect(String(url)).toContain('peerNumber=%2B14155550100');
    expect((init as { method: string; body?: string }).method).toBe('GET');
    expect((init as { body?: string }).body).toBeUndefined();
  });

  it('refuses with a typed failure when the workspace has no connected key (BYO-only)', async () => {
    const out = await saperlyExecutor(
      ctx({ functionName: 'list_numbers', credentials: { flowKind: 'api_key' } as ExecutorContext['credentials'] }),
    );
    expect(out.failure?.message).toContain('connected workspace key');
  });

  it('refuses when a required path param is missing', async () => {
    const out = await saperlyExecutor(ctx({ functionName: 'get_number', input: {} }));
    expect(out.failure?.message).toContain("missing required 'id'");
  });

  it('reports a vendor non-2xx as a typed failure, never success', async () => {
    mockFetchOnce(402, { error: 'insufficient balance' });
    const out = await saperlyExecutor(ctx({ functionName: 'provision_number', input: { country: 'US', numberType: 'local' } }));
    expect(out.failure?.message).toContain('insufficient balance');
  });

  it('refuses an unknown function name', async () => {
    const out = await saperlyExecutor(ctx({ functionName: 'not_a_tool' }));
    expect(out.failure?.message).toContain('no tool named');
  });
});
