/**
 * Fence: routing to a workspace's own vendor goes through the team binding.
 *
 * The tenant-level set (getTenantConnectedWebVendors) answers "did the
 * workspace connect it", which is the right question for OFFERING a tool and
 * for whose capacity ceiling applies, and the wrong question for ROUTING a
 * call: a team bound to nothing must not spend an account another team
 * connected. The router therefore
 * reads vendor-scope.ts and nothing else, and every new reader of the
 * tenant-level set has to be added here on purpose, with the reason.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..', '..', '..');

/** Production files allowed to read the tenant-level set, and why. */
const ALLOWED_READERS: Record<string, string> = {
  'integrations/web-fetch/web-tool-secrets.ts': 'defines it',
  'integrations/web-fetch/vendor-scope.ts': 'intersects it with the binding — the one routing reader',
  'integrations/web-fetch/expose-tools.ts': 'offers tools (tier 1 is tenant-level by design; the route is scoped)',
  'browser-sessions/session-vendor-proxy.ts': 'prefetches it for the capacity ceiling and hands it to the scope helper',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('web vendor scope fence', () => {
  it('only the listed production files read the tenant-level connected set', () => {
    const readers = walk(SRC)
      .filter((p) => readFileSync(p, 'utf8').includes('getTenantConnectedWebVendors('))
      .map((p) => relative(SRC, p))
      .sort();
    expect(readers).toEqual(Object.keys(ALLOWED_READERS).sort());
  });

  it('the router decides every connector-backed chain from the scoped set and hands each client its scope', () => {
    const src = readFileSync(join(SRC, 'integrations/web-fetch/router.ts'), 'utf8');
    expect(src).not.toMatch(/getTenantConnectedWebVendors/);
    // The five entries that can reach a workspace account each read the scope
    // once and log what it left out.
    expect(src.match(/usableWebVendors\(ctx\.tenantId, ctx\.agentId\)/g)?.length).toBe(5);
    for (const tool of ['web_fetch_advanced', 'web_extract', 'web_task', 'web_research', 'web_diff']) {
      expect(src).toMatch(new RegExp(`logExcludedVendors\\(scope, \\{ \\.\\.\\.ctx, toolName: '${tool}' \\}\\)`));
    }
    // No ambient channel: the scope is a value on every connector-backed
    // request, and a client refuses a request without one (typecheck).
    expect(src).not.toMatch(/withCredentialScope|AsyncLocalStorage/);
    expect(src.match(/credentialScopeFor\(scope, /g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('every credential read names its scope: no client resolves a key by tenant alone', () => {
    const offenders = walk(SRC)
      .filter((p) => /getWebToolCredential\([^)]*\)/.test(readFileSync(p, 'utf8')))
      .flatMap((p) => {
        const text = readFileSync(p, 'utf8');
        const calls = text.match(/getWebToolCredential\([^)]*\)/g) ?? [];
        return calls
          .filter((c) => !c.startsWith('getWebToolCredential(\n'))
          .filter((c) => c.split(',').length < 3)
          .map((c) => `${relative(SRC, p)}: ${c}`);
      });
    expect(offenders).toEqual([]);
  });
});
