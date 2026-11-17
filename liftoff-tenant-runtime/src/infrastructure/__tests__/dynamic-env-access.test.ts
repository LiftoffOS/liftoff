// FITNESS FUNCTION — the blind spot in `r5/no-process-env-secret`.
//
// That rule matches `process.env.NAME` and `process.env['NAME']`, where the
// name is a literal it can compare against the managed list. It cannot see
// `process.env[envVar]`, and neither can a reader skimming a diff.
//
// That gap is not hypothetical. `security/service-auth.ts` verified the INBOUND
// `X-Service-Auth` header with `process.env[envVar]`, defaulting to
// TENANT_RUNTIME_SERVICE_TOKEN. Once hydration stopped writing the environment,
// every route behind `requireServiceAuth()` — memory, coordinator, reflection,
// connector-replica, agent-lifecycle, insights — would have answered 500
// "Service authentication not configured". Lint was clean, types were clean,
// and the whole split-service RPC surface was down.
//
// So every dynamic read is enumerated here and has to say which it is: reading
// a managed secret (must go through the store) or reading something else.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

/** `process.env[<not a quote>]` — a computed key. */
const DYNAMIC = /process\.env\[[^'"\]]/;

/** Source with line comments removed.
 *
 *  Several files here DESCRIBE the pattern in prose — `service-client-auth.ts`
 *  exists because the service-client package resolves
 *  `process.env[serviceAuthEnvVar]` — and a documentation mention is not a read. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every file that reads `process.env` with a computed key, and why it is safe.
 *
 * Adding a file here is a deliberate act: say which variables it can reach, and
 * if any of them is a managed secret, route it through `getManagedSecret`.
 */
const KNOWN_DYNAMIC_READERS: Record<string, string> = {
  'infrastructure/secret-store.ts':
    'the store itself — the documented fallback for local dev and tests',
  'infrastructure/secrets.ts':
    'the hydrator — it writes and reads the manifest by name, which is its job',
  'infrastructure/runtime-env.ts':
    'reads URL and flag variables by name; no managed secret is in its tables',
  'memory/env-validator.ts':
    'iterates its own RULES map — MEM_* and HARVEST_* tuning knobs only',
  'diagnostics/adapters/cross-db.ts':
    'DIAGNOSTICS_*_DB_URL connection strings, which are not managed secrets',
  'agent-execution/adapter/child-process-env.ts':
    'walks the child allow-list, which is asserted to carry no credential',
  'agent-execution/certification/startup-validation.ts':
    'reads an engine binary\'s path override (ENGINE_BINARY.overrideEnv: GEMINI_CLI_PATH) and PATH; a filesystem path, not a secret',
  'scripts/memory-eval/replay.ts':
    'an offline eval script that sets and restores MEM_* weights',
};

describe('dynamic process.env reads', () => {
  const found = walk(SRC)
    .filter((f) => DYNAMIC.test(code(f)))
    .map((f) => f.slice(SRC.length + 1))
    .sort();

  it('finds them at all, so this cannot pass vacuously', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it('every one is accounted for', () => {
    const unexplained = found.filter((f) => !(f in KNOWN_DYNAMIC_READERS));
    expect({
      unexplained,
      hint: unexplained.length === 0
        ? 'ok'
        : 'These read process.env with a computed key, which r5/no-process-env-secret cannot '
          + 'check. If the key can be a managed secret, read it through getManagedSecret() — '
          + 'it falls back to process.env, so non-managed variables are unaffected. Then add '
          + 'the file here with the reason.',
    }).toEqual({ unexplained: [], hint: 'ok' });
  });

  it('the list has not gone stale', () => {
    // A file that stopped reading dynamically should stop being excused.
    const gone = Object.keys(KNOWN_DYNAMIC_READERS).filter((f) => !found.includes(f));
    expect(gone).toEqual([]);
  });

  it('the inbound service-auth verifier reads through the store', () => {
    // Named specifically because it is the one that was broken, and because its
    // failure is a 500 on every service-to-service call rather than anything
    // that looks like a secrets problem.
    const src = readFileSync(join(SRC, 'security', 'service-auth.ts'), 'utf8');
    expect(src).toContain('const expectedToken = getManagedSecret(envVar);');
    expect(src).not.toContain('const expectedToken = process.env[envVar];');
  });
});
