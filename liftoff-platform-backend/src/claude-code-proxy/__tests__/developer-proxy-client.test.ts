// Tests for pipeToDeveloperProxy's header handling.
//
// The proxy forwards two DISTINCT auth schemes to the developer-proxy:
//   - Claude Code / Anthropic authenticates with `x-api-key`.
//   - Codex / OpenAI authenticates with `Authorization: Bearer <liftoff_sk_>`.
// Both carry the liftoff_sk_ key; the proxy's auth layer reads either. The
// Cloud Run IAM OIDC token must therefore ride on X-Serverless-Authorization so
// it never clobbers the client's Authorization header. Regressing this breaks
// EVERY Codex operation (catalog, inference, pause/resume/revoke) with a 401.

const mockBuildOidc = jest.fn();
jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: (...args: unknown[]) => mockBuildOidc(...args),
}));

import { pipeToDeveloperProxy, revokeCredential, createCredential } from '../developer-proxy-client';

const OLD_ENV = process.env.DEVELOPER_PROXY_SERVICE_URL;

describe('pipeToDeveloperProxy header handling', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    process.env.DEVELOPER_PROXY_SERVICE_URL = 'https://devproxy.internal';
    mockBuildOidc.mockResolvedValue({ Authorization: 'Bearer OIDC_TOKEN' });
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.DEVELOPER_PROXY_SERVICE_URL = OLD_ENV;
  });

  function headersFromLastCall(): Record<string, string> {
    return fetchMock.mock.calls[0][1].headers as Record<string, string>;
  }

  it('forwards the client Authorization (Codex) and routes OIDC to X-Serverless-Authorization', async () => {
    await pipeToDeveloperProxy(
      'GET',
      '/codex/v1/models',
      { authorization: 'Bearer liftoff_sk_codex', 'content-type': 'application/json' },
      undefined,
    );

    const headers = headersFromLastCall();
    // The client's proxy key must survive so the proxy's auth layer sees it.
    expect(headers.authorization).toBe('Bearer liftoff_sk_codex');
    // The IAM token must NOT overwrite it.
    expect(headers['X-Serverless-Authorization']).toBe('Bearer OIDC_TOKEN');
  });

  it('forwards x-api-key (Claude Code) unchanged with OIDC on X-Serverless-Authorization', async () => {
    await pipeToDeveloperProxy(
      'POST',
      '/v1/messages',
      { 'x-api-key': 'liftoff_sk_cc', 'content-type': 'application/json' },
      Buffer.from('{}'),
    );

    const headers = headersFromLastCall();
    expect(headers['x-api-key']).toBe('liftoff_sk_cc');
    expect(headers.authorization).toBeUndefined();
    expect(headers['X-Serverless-Authorization']).toBe('Bearer OIDC_TOKEN');
  });
});

// A bodyless request (e.g. revoke's DELETE) must NOT set Content-Type:
// application/json — the proxy's Fastify JSON parser rejects an empty body
// with "Body cannot be empty when content-type is set to 'application/json'"
// (HTTP 400), which broke archive/revoke for every credential.
describe('devProxyJson Content-Type handling', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    process.env.DEVELOPER_PROXY_SERVICE_URL = 'https://devproxy.internal';
    mockBuildOidc.mockResolvedValue({ Authorization: 'Bearer OIDC_TOKEN' });
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.DEVELOPER_PROXY_SERVICE_URL = OLD_ENV;
  });

  function headersFromLastCall(): Record<string, string> {
    return fetchMock.mock.calls[0][1].headers as Record<string, string>;
  }

  it('omits Content-Type on a bodyless DELETE (revoke)', async () => {
    await revokeCredential({ id: 'cred-1', tenantId: 't1', userId: 'u1' });
    const headers = headersFromLastCall();
    expect(headers['Content-Type']).toBeUndefined();
    // Auth/routing headers still present.
    expect(headers['x-tenant-id']).toBe('t1');
    expect(headers['x-user-id']).toBe('u1');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('sets Content-Type on a request that carries a JSON body (create)', async () => {
    await createCredential({ tenantId: 't1', userId: 'u1', vendor: 'openai', apiKey: 'sk-x' });
    const headers = headersFromLastCall();
    expect(headers['Content-Type']).toBe('application/json');
    expect(fetchMock.mock.calls[0][1].body).toBeDefined();
  });
});
