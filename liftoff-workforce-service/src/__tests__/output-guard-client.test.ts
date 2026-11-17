// The guard client: the scrubbed text goes to platform-backend with the
// service's auth, the guarded text comes back, and every failure fails open
// to the scrubbed text, never to the raw one.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../infrastructure/service-auth.js', () => ({
  getServiceAuthHeaders: jest.fn().mockResolvedValue({
    Authorization: 'Bearer oidc',
    'X-Service-Auth': 'test-service-auth',
  }),
}));

import { resetConfigForTests } from '../infrastructure/config.js';
import { log } from '../infrastructure/logging.js';
import { guardOutgoingText } from '../workforce-plans/output-guard-client.js';

const mockFetch = jest.fn();
const ID = '122662dd-de4e-4b0d-8873-50cd6a00daaf';
const CTX = { tenantId: 'tenant-1', threadId: 'tp-1', toolNames: ['team_update'] };

function jsonResponse(body: unknown, status = 200): unknown {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'http://pb.test';
  process.env['GCP_PROJECT_ID'] = 'test';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:us-west1:test-db';
  process.env['WORKFORCE_SERVICE_TOKEN'] = 'wf-token';
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

describe('guardOutgoingText', () => {
  it('sends the scrubbed text with the service auth, and returns what platform-backend read out', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'I will apply it when you say yes.', changed: true }));

    const out = await guardOutgoingText(`I will call \`team_update\` on (id ${ID}) when you say yes, per the request.`, CTX);

    expect(out).toBe('I will apply it when you say yes.');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://pb.test/api/internal/output-guard');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer oidc', 'X-Service-Auth': 'test-service-auth' });
    expect(JSON.parse(init.body)).toEqual({
      tenantId: 'tenant-1',
      speaker: 'caio',
      threadId: 'tp-1',
      toolNames: ['team_update'],
      text: 'I will call on when you say yes, per the request.',
    });
  });

  it('fails open to the scrubbed text on a transport error, a 5xx, or an empty answer', async () => {
    const raw = `Done (id ${ID}).`;
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await guardOutgoingText(raw, CTX)).toBe('Done.');
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'x' }, 503));
    expect(await guardOutgoingText(raw, CTX)).toBe('Done.');
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: '   ' }));
    expect(await guardOutgoingText(raw, CTX)).toBe('Done.');
    expect((log.error as jest.Mock).mock.calls).toHaveLength(2);
  });

  it('does not call out for whitespace', async () => {
    expect(await guardOutgoingText('\n\n', CTX)).toBe('\n\n');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
