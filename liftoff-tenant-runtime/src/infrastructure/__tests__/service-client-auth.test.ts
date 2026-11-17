// FITNESS FUNCTION — service-to-service auth without a secret in the environment.
//
// `@liftoffos/service-client` sends the shared bearer from
// `process.env[serviceAuthEnvVar]`, and takes a variable NAME rather than a
// value. `withManagedServiceAuth` supplies the same header from the secret
// store through the client's `fetchImpl` seam instead.
//
// Three properties, and the third is why `fetchImpl` was chosen over
// `defaultHeaders`.

import { ServiceClient } from '@liftoffos/service-client';
import { withManagedServiceAuth } from '../service-client-auth';
import { _clearManagedSecrets, setManagedSecret } from '../secret-store';

/** Capture what actually goes on the wire. */
function captureFetch() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const impl = jest.fn(async (input: unknown, init?: { headers?: HeadersInit }) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { calls, impl };
}

describe('withManagedServiceAuth', () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    _clearManagedSecrets();
    process.env = { ...ORIGINAL_ENV };
  });

  it('sends the bearer from the store', async () => {
    const { calls, impl } = captureFetch();
    globalThis.fetch = impl as unknown as typeof fetch;
    setManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN', 'tok-from-store');

    const client = new ServiceClient(withManagedServiceAuth('TENANT_RUNTIME_SERVICE_TOKEN', {
      resolveTargetUrl: async () => 'https://peer.example',
    }));
    await client.fetch('t1', '/v1/ping', { method: 'POST' });

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get('x-service-auth')).toBe('tok-from-store');
  });

  it('omits the header entirely when there is no token', async () => {
    // Not an empty bearer. An empty one reaches the server as a credential
    // that fails to verify, rather than as a request that never claimed one —
    // and the client's own path sets the header only `if (token)`.
    const { calls, impl } = captureFetch();
    globalThis.fetch = impl as unknown as typeof fetch;

    const client = new ServiceClient(withManagedServiceAuth('TENANT_RUNTIME_SERVICE_TOKEN', {
      resolveTargetUrl: async () => 'https://peer.example',
    }));
    await client.fetch('t1', '/v1/ping');

    expect(calls[0].headers.has('x-service-auth')).toBe(false);
  });

  it('resolves per REQUEST, not at construction', async () => {
    // The reason this uses `fetchImpl` rather than `defaultHeaders`.
    //
    // Three of the four callers build their ServiceClient inside a constructor,
    // and only happen to be instantiated lazily today. If the token were read
    // when the client was built, moving one construction to module load would
    // send an empty bearer forever — a 401 storm with no type error and nothing
    // in the diff to point at.
    const { calls, impl } = captureFetch();
    globalThis.fetch = impl as unknown as typeof fetch;

    // Built BEFORE the secret exists, exactly as a module-load construction would be.
    const client = new ServiceClient(withManagedServiceAuth('TENANT_RUNTIME_SERVICE_TOKEN', {
      resolveTargetUrl: async () => 'https://peer.example',
    }));

    setManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN', 'tok-hydrated-later');
    await client.fetch('t1', '/v1/ping');

    expect(calls[0].headers.get('x-service-auth')).toBe('tok-hydrated-later');
  });

  it('picks up a rotated token without rebuilding the client', async () => {
    const { calls, impl } = captureFetch();
    globalThis.fetch = impl as unknown as typeof fetch;
    setManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN', 'first');

    const client = new ServiceClient(withManagedServiceAuth('TENANT_RUNTIME_SERVICE_TOKEN', {
      resolveTargetUrl: async () => 'https://peer.example',
    }));
    await client.fetch('t1', '/v1/ping');
    setManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN', 'second');
    await client.fetch('t1', '/v1/ping');

    expect(calls.map((c) => c.headers.get('x-service-auth'))).toEqual(['first', 'second']);
  });

  it('leaves the caller\'s own headers alone', async () => {
    const { calls, impl } = captureFetch();
    globalThis.fetch = impl as unknown as typeof fetch;
    setManagedSecret('PLATFORM_CALLBACK_TOKEN', 'tok');

    const client = new ServiceClient(withManagedServiceAuth('PLATFORM_CALLBACK_TOKEN', {
      resolveTargetUrl: async () => 'https://peer.example',
    }));
    await client.fetch('t1', '/v1/thing', { headers: { 'X-Request-Id': 'abc' } });

    expect(calls[0].headers.get('x-request-id')).toBe('abc');
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(calls[0].headers.get('x-service-auth')).toBe('tok');
  });
});
