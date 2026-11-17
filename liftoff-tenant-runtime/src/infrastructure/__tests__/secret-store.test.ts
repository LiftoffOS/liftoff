// FITNESS FUNCTION — the secret store, and the three lists that have to agree.
//
// A secret's name appears in four places: the hydration manifest, the store's
// own roster, the eslint rule that keeps readers off `process.env`, and the
// short list of secrets that must ALSO be written to the environment because
// something outside this repo reads them from there.
//
// Any two of those drifting apart fails silently and in the worst direction. A
// secret in the manifest but not in the rule's list is one the rule stops
// covering, so a `process.env` read of it lints clean and returns undefined in
// production. A secret wrongly marked env-bound is one that stays in
// `process.env` for no reason, which is the whole exposure this store exists to
// remove.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ENV_BOUND_SECRETS,
  MANAGED_SECRET_NAMES,
  _clearManagedSecrets,
  getManagedSecret,
  managedSecretNames,
  setManagedSecret,
} from '../secret-store';

const ROOT = join(__dirname, '..', '..', '..');
const RULE_SOURCE = readFileSync(join(ROOT, 'eslint-rules', 'no-process-env-secret.js'), 'utf8');
const SECRETS_SOURCE = readFileSync(join(ROOT, 'src', 'infrastructure', 'secrets.ts'), 'utf8');

/** Names the eslint rule actually covers. */
function ruleCoveredNames(): string[] {
  const block = RULE_SOURCE.split('const MANAGED_SECRETS = new Set([')[1]?.split(']);')[0] ?? '';
  return [...block.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]).sort();
}

/** Env var names the hydration manifest declares. */
function manifestNames(): string[] {
  return [...SECRETS_SOURCE.matchAll(/envVar:\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]).sort();
}

/** Secrets this repo hands to `@liftoffos/service-client` BY NAME.
 *
 *  That client resolves `process.env[serviceAuthEnvVar]` itself
 *  (`dist/service-client.js:123`), so anything listed this way has to remain in
 *  the environment no matter what this store does. */
function serviceClientEnvNames(): string[] {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of require('fs').readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/serviceAuthEnvVar:\s*(?:[^'"\n]*\?\?\s*)?'([A-Z][A-Z0-9_]*)'/g)) {
          names.add(m[1]);
        }
      }
    }
  };
  walk(join(ROOT, 'src'));
  return [...names].sort();
}

describe('the lists agree', () => {
  it('the eslint rule covers exactly the secrets the store manages', () => {
    // Kept as two literals rather than one import because the rule is CommonJS
    // loaded by eslint and the store is TypeScript. This test is the join.
    expect(ruleCoveredNames()).toEqual([...MANAGED_SECRET_NAMES].sort());
  });

  it('every secret the manifest hydrates is one the store manages', () => {
    const unmanaged = manifestNames().filter(
      (name) => !(MANAGED_SECRET_NAMES as readonly string[]).includes(name),
    );
    expect({
      unmanaged,
      hint: unmanaged.length === 0
        ? 'ok'
        : 'These are hydrated by loadSecretsToEnv but absent from MANAGED_SECRET_NAMES, so the '
          + 'eslint rule does not cover them: a process.env read of one lints clean and returns '
          + 'undefined in production.',
    }).toEqual({ unmanaged: [], hint: 'ok' });
  });
});

describe('ENV_BOUND_SECRETS', () => {
  it('names only secrets that are really read from the environment by the package', () => {
    // Both directions. A name here that no `serviceAuthEnvVar` consumes is a
    // secret left in `process.env` for a reason that has expired — which is
    // exactly how this list would stop shrinking.
    expect([...ENV_BOUND_SECRETS].sort()).toEqual(serviceClientEnvNames());
  });

  it('is empty, so no managed secret is in this process\'s environment', () => {
    // The whole property in one assertion. `loadSecretsToEnv` writes nothing to
    // `process.env`, so there is nothing there for a child to inherit, for a
    // crash dump to serialize, or for a library walking the environment to
    // find.
    //
    // Adding a name here is meant to hurt. The one case that nearly earned an
    // entry — `@liftoffos/service-client` resolving its bearer by variable name
    // — was solved through the client's own `fetchImpl` seam instead
    // (service-client-auth.ts), which is the shape of answer to look for first.
    expect(ENV_BOUND_SECRETS).toEqual([]);
  });
});

describe('the service-client package never resolves a secret for us', () => {
  // Both directions of service auth live in `@liftoffos/service-client`, and
  // BOTH read `process.env` by variable name:
  //
  //   ServiceClient({ serviceAuthEnvVar })  sends the bearer   (:123)
  //   verifyServiceAuth({ tokenEnvVar })    checks the bearer  (verify-service-auth.js:15)
  //
  // Neither takes a value or a resolver, and this runtime no longer keeps
  // secrets in the environment. Migrating only the outbound half leaves the
  // inbound one broken: `/api/internal/event-status` then answers 500 on every
  // request, because the package returns 500 — not 401 — when the token it
  // looks for is not configured. It reads as a broken endpoint rather than as
  // a secrets problem.
  //
  // Outbound goes through `withManagedServiceAuth` (fetchImpl seam), inbound
  // through this repo's own `requireServiceAuth`, which reads the store and has
  // the same default semantics.

  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of require('fs').readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          out.push(full);
        }
      }
    };
    walk(join(ROOT, 'src'));
    return out;
  }

  /** Files that IMPORT a given name from the package. */
  function importersOf(name: string): string[] {
    const pattern = new RegExp(
      `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'@liftoffos/service-client'`,
    );
    return sourceFiles()
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1))
      .sort();
  }

  it('nothing imports verifyServiceAuth', () => {
    expect({
      importers: importersOf('verifyServiceAuth'),
      hint: 'The package resolves the expected token from process.env and answers 500 when it '
        + 'is absent. Use requireServiceAuth from src/security/service-auth, which reads the '
        + 'store and defaults to the same shared-bearer-only behaviour.',
    }).toEqual({ importers: [], hint: expect.any(String) });
  });

  it('nothing passes serviceAuthEnvVar to a ServiceClient', () => {
    const offenders = sourceFiles()
      .filter((f) => /serviceAuthEnvVar\s*:/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1))
      .sort();
    expect({
      offenders,
      hint: 'Construct with withManagedServiceAuth(secretName, options) instead: it supplies '
        + 'X-Service-Auth from the store per request through the client fetchImpl seam.',
    }).toEqual({ offenders: [], hint: expect.any(String) });
  });
});

describe('reading a secret', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    _clearManagedSecrets();
    process.env = { ...ORIGINAL };
  });

  it('returns what was hydrated', () => {
    setManagedSecret('ANTHROPIC_API_KEY', 'sk-from-store');
    expect(getManagedSecret('ANTHROPIC_API_KEY')).toBe('sk-from-store');
  });

  it('prefers the store over the environment', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';
    setManagedSecret('ANTHROPIC_API_KEY', 'sk-from-store');
    expect(getManagedSecret('ANTHROPIC_API_KEY')).toBe('sk-from-store');
  });

  it('falls back to the environment, so local dev and tests keep working', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';
    expect(getManagedSecret('ANTHROPIC_API_KEY')).toBe('sk-from-env');
  });

  it('treats an empty value as absent in both places', () => {
    // An empty password baked into a pg connection string fails SASL with
    // "client password must be a string", five minutes later and nowhere near
    // the cause.
    process.env.DB_PASSWORD = '';
    setManagedSecret('DB_PASSWORD', '');
    expect(getManagedSecret('DB_PASSWORD')).toBeUndefined();
  });

  it('reports the names it holds and never the values', () => {
    setManagedSecret('DB_PASSWORD', 'hunter2');
    expect(managedSecretNames()).toEqual(['DB_PASSWORD']);
    expect(JSON.stringify(managedSecretNames())).not.toContain('hunter2');
  });
});
