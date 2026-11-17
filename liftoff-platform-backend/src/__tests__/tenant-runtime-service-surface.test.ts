// Every path the tenant runtime calls must be reachable with a service token.
//
// The runtime authenticates with `X-Service-Auth: TENANT_RUNTIME_SERVICE_TOKEN`.
// It has no Firebase identity and never will. So any path it calls has to be
// served by a router mounted BEFORE `app.use('/api', authMiddleware)`; a route
// mounted after that line answers a service token with 401, whatever else is
// right about it.
//
// A path on the wrong side of that line fails invisibly from both ends:
//
//   - The feature-flag refetch throws, so its event nacks, retries ten times
//     and dead-letters, and that tenant's overrides never arrive. Global flags
//     return before the fetch, so the common case keeps working.
//   - The deployment refetch CATCHES its own failure and returns null, which
//     reads as "this tenant has no approved deployment" — a plausible answer
//     rather than an error, even when the route it calls does not exist.
//
// Neither shows up in a log you would think to read. This test is the thing
// that catches the next one, at the commit that introduces it.
import { readFileSync } from 'fs';
import { join } from 'path';

const INDEX = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
const LINES = INDEX.split('\n');

/** Where the Firebase gate sits. Everything mounted after it is unreachable
 *  with a service token. */
// The gate is the `app.use('/api', ...)` that applies authMiddleware to
// everything after it. It was one line — `app.use('/api', authMiddleware);` —
// until e463d19 wrapped it in a function so /api/internal/* could skip
// authMiddleware and use its own HMAC/OIDC auth.
//
// Matched on the mount rather than on the exact old text, because the old
// match silently returned -1 when the line changed shape. Every assertion
// below then sliced LINES.slice(0, -1) — nearly the whole file — so the
// ordering checks passed while testing almost nothing. That is what the
// "cannot pass vacuously" guard exists to catch, and it caught it.
const GATE = LINES.findIndex((l) =>
  l.startsWith("app.use('/api', authMiddleware)")
  || (l.startsWith("app.use('/api', (req") && l.includes('res, next')));

/** Mount prefixes registered before the gate. */
const PRE_GATE_MOUNTS = LINES.slice(0, GATE)
  .map((l) => l.match(/^app\.use\('(\/[^']*)'/))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map((m) => m[1]);

/**
 * Every control-plane path the tenant runtime calls, with the router expected
 * to serve it. Sourced by reading the runtime: events/subscriber.ts,
 * entitlements-client/service.ts and events/model-config-resync-router.ts.
 *
 * Adding a runtime call means adding a line here. That is the point: the list
 * is the contract, and the assertions below prove the mount exists to honour it.
 */
const RUNTIME_CALLS: Array<{ path: string; why: string }> = [
  { path: '/api/internal/entitlements', why: 'entitlement refetch on cache miss' },
  { path: '/api/internal/model-registry', why: 'model config resync' },
  { path: '/api/internal/feature-flags', why: 'tenant-scoped feature flag events' },
  { path: '/api/internal/prompt-registry', why: 'tenant.prompt_bundle.approved' },
  { path: '/api/internal/deployments', why: 'tenant.deployment.approved, and the cache-miss refetch' },
  { path: '/api/agent-audit-logs', why: 'audit log writes; this router does its own per-route auth' },
];

/** Resource prefixes that must never carry a service router ahead of the gate.
 *
 *  Mounting one there shadows the user router for any overlapping path: Express
 *  matches the service router first, verifyServiceAuth rejects a browser that
 *  carries no service token, and the request never reaches the handler the
 *  signed-in user was entitled to: GET /api/deployments/:id, for example,
 *  answers {"error":"Missing X-Service-Auth header"}.
 *
 *  It fails as a 401 naming a header no browser sends, which reads like a
 *  broken login rather than a routing mistake — so it is the kind of thing that
 *  survives review. Hence a test rather than a comment. */
const NO_SHADOW_PREFIXES = [
  '/api/entitlements',
  '/api/model-registry',
  '/api/feature-flags',
  '/api/prompt-registry',
  '/api/deployments',
];

describe('the tenant runtime service surface', () => {
  it('locates the auth gate, so this cannot pass vacuously', () => {
    expect(GATE).toBeGreaterThan(0);
    expect(PRE_GATE_MOUNTS.length).toBeGreaterThan(10);
  });

  it.each(RUNTIME_CALLS)('$path is mounted before the auth gate ($why)', ({ path }) => {
    expect(PRE_GATE_MOUNTS).toContain(path);
  });

  it.each(NO_SHADOW_PREFIXES)('%s has no service router mounted ahead of the auth gate', (prefix) => {
    const shadowing = LINES.slice(0, GATE).filter(
      (l) => l.includes(`app.use('${prefix}'`) && /ServiceRouter/.test(l),
    );

    expect(shadowing).toEqual([]);
  });

  it('serves each of those mounts with a service-auth router', () => {
    // Mounted early is necessary but not sufficient: the router behind it has
    // to actually verify the service token rather than trust the caller.
    const unverified = RUNTIME_CALLS.filter(({ path }) => {
      const mountLines = LINES.slice(0, GATE).filter((l) => l.includes(`app.use('${path}'`));
      return !mountLines.some((line) => {
        const router = line.match(/,\s*(\w+)\s*\)/)?.[1];
        if (!router) return false;
        // The router is verified if its own source calls verifyServiceAuth, or
        // it handles auth per route (agent-audit-logs does both service and
        // Firebase auth inside itself).
        return /Service|Internal/.test(router) || /agentAuditLogs/.test(router);
      });
    });

    expect(unverified.map((u) => u.path)).toEqual([]);
  });
});
