// Service-to-service auth for a runtime that keeps its secrets out of the
// environment.
//
// `@liftoffos/service-client` has one built-in way to send the shared bearer:
// `serviceAuthEnvVar`, a variable NAME it resolves itself with
// `process.env[name]` (dist/service-client.js:164 in 0.2.0). That is incompatible with
// the secret store — `loadSecretsToEnv` hydrates a Map, so the variable it
// looks up is not there — and the option takes a name, so there is nowhere to
// hand it a value instead.
//
// Changing the package is the tidier answer and it is a four-repo landing:
// publish from its own repo, then update each consumer's lockfile. This does
// not need that, because the client already has a seam that does the job.
//
// ── Why `fetchImpl` rather than `defaultHeaders` ───────────────────────────
//
// `defaultHeaders` is read per request (`Object.entries` inside buildHeaders),
// so a getter on it would also resolve at call time. It was rejected: it
// depends on the client iterating that object on every request rather than
// spreading it once at construction, which is an internal detail that a
// version bump may change silently — and the failure would be an empty bearer,
// i.e. a 401 storm, not a type error.
//
// `fetchImpl` is a documented option applied at the last moment
// (`this.fetchImpl(url, fetchInit)`, :218 in 0.2.0), so the header is set per
// request from the store. Construction order stops mattering, which matters
// because three of the four clients build their ServiceClient in a constructor
// and only happen to be instantiated lazily today.
//
// NOTHING IS LOST BY OVERRIDING IT. Since 0.2 the client no longer installs a
// process-wide dispatcher: it hands each request its own HTTP/1.1 keep-alive
// Agent (or the one its `dispatcher` option names) as `init.dispatcher`, along
// with the timeout `signal`, and the wrapper below spreads `init` into
// `globalThis.fetch`, so both reach the request exactly as they would without
// it. The default is `options.fetchImpl ?? globalThis.fetch`.

import type { ServiceClientOptions } from '@liftoffos/service-client';
import { getManagedSecret, type ManagedSecretName } from './secret-store';

/**
 * ServiceClient options that send `X-Service-Auth` from the secret store.
 *
 * Deliberately omits `serviceAuthEnvVar` from what a caller may pass: setting
 * both would send the header twice from two different sources, and the one
 * reading `process.env` would win by running last.
 */
export function withManagedServiceAuth(
  secretName: ManagedSecretName,
  options: Omit<ServiceClientOptions, 'serviceAuthEnvVar' | 'fetchImpl'>,
): ServiceClientOptions {
  return {
    ...options,
    fetchImpl: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const token = getManagedSecret(secretName);
      // Absent means absent. The client's own path sets the header only
      // `if (token)`, and an empty bearer is not the same as no bearer: it
      // reaches the server as a credential that fails to verify rather than as
      // a request that never claimed to have one.
      if (!token) return globalThis.fetch(input, init);
      const headers = new Headers(init?.headers);
      headers.set('X-Service-Auth', token);
      return globalThis.fetch(input, { ...init, headers });
    },
  };
}
