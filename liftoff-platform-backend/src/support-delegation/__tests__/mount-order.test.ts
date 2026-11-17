// A support session is only coherent if EVERY route that resolves a user
// identity resolves the same one.
//
// The original design assumed the global authMiddleware was the single choke
// point, so one delegation middleware behind it covered everything. That was
// wrong: several routers mount far earlier with their own optionalAuthMiddleware
// and never reach it. /api/tenant-members is the costly one — /my-memberships
// decides which workspace the whole dashboard drives off, so a support session
// lists the OPERATOR'S workspaces, selects one, and then every correctly
// delegated call 403s because the customer is not a member of it. The entire
// dashboard fails at once.
//
// This test reads the mount order out of index.ts so the next router added with
// its own auth cannot quietly reintroduce it.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/** Mounts that must NOT be delegated, each with the reason it is exempt. */
const EXEMPT: Record<string, string> = {
  '/api/passkeys':
    'passkey registration must keep acting on the operator OWN account; delegating it would let a support session enrol a credential on the customer',
};

describe('support delegation covers every user-identity mount', () => {
  const src = readFileSync(join(__dirname, '../../index.ts'), 'utf8');
  const lines = src.split('\n');

  const globalMountIdx = lines.findIndex((l) =>
    l.includes('return supportDelegationMiddleware(req, res, next)'),
  );

  it('finds the global delegation mount, so this cannot pass vacuously', () => {
    expect(globalMountIdx).toBeGreaterThan(-1);
  });

  it('every router mounted with its own auth BEFORE the global mount is delegated or exempt', () => {
    const offenders: string[] = [];

    lines.slice(0, globalMountIdx).forEach((line, i) => {
      if (!/app\.use\(/.test(line)) return;
      if (!/optionalAuthMiddleware|authMiddleware/.test(line)) return;

      const path = line.match(/app\.use\(\s*'([^']+)'/)?.[1];
      if (!path) return;
      if (EXEMPT[path]) return;
      if (line.includes('supportDelegationMiddleware')) return;

      offenders.push(`index.ts:${i + 1}  ${path}`);
    });

    expect(offenders).toEqual([]);
  });


  it('no router uses a bare authMiddleware; identity and delegation stay paired', () => {
    // The global mount is not the only way a route establishes identity. Some
    // routers must mount before the global gate (to serve service-auth POSTs)
    // and so apply authMiddleware per-route. Every one of those is a place a
    // support session silently answers as the OPERATOR while the rest of the
    // app answers as the customer. /api/agent-audit-logs shipped exactly that,
    // and the Activity page 403'd on the customer's own tenant.
    const root = join(__dirname, '../..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '__tests__') continue;
          walk(full);
        } else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
          files.push(full);
        }
      }
    };
    walk(root);

    // Allowed to name it: the definition, the composed pair, and index.ts,
    // whose global mount is followed by the global delegation mount (asserted
    // by the tests above).
    const ALLOWED = ['infrastructure/middleware.ts', 'support-delegation/authed.ts', 'index.ts'];

    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(root.length + 1);
      if (ALLOWED.some((a) => rel.endsWith(a))) continue;
      const body = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('import '))
        .join('\n');
      // Handler position: `authMiddleware,` or `(authMiddleware` — never the
      // composed `authedWithDelegation`.
      if (/(^|[\s(,])authMiddleware\s*[,)]/m.test(body)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps passkeys undelegated, on purpose', () => {
    const passkeys = lines.find((l) => l.includes("app.use('/api/passkeys'"));
    expect(passkeys).toBeDefined();
    expect(passkeys).not.toContain('supportDelegationMiddleware');
  });

  it('delegates the mount that decides which workspace the dashboard uses', () => {
    const tm = lines.find((l) => l.includes("app.use('/api/tenant-members'"));
    expect(tm).toContain('supportDelegationMiddleware');
  });
});
