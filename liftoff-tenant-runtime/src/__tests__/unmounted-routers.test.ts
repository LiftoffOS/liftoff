// No router may ship without a mount.
//
// The sibling reachability gate cannot see this one. A router declares its
// routes by calling itself, so `someRouter.get(...)` in the declaring file
// reads as a use and an unmounted router looks alive. That gap shipped a real
// defect: `memoryRouter` was written in March, never mounted, and the control
// plane's three callers — the CAIO's cross-thread memory, skill-feedback
// writes, and the MCP share tool — took a 404 on every request and swallowed
// it, reporting success while storing nothing.
//
// Mounting always happens in another file, so for this shape a self-reference
// proves nothing and is not counted.

import { findUnmountedRouters, orphanKey } from './reachability';

// Routers that exist with no mount and no caller asking for one. Each needs a
// decision — mount it or delete it — not a permanent home on this list.
const KNOWN_UNMOUNTED_ROUTERS: readonly string[] = [
  // DLQ management endpoints. Nothing in this repo or the control plane calls
  // them; DLQ draining runs as a control-plane job instead.
  'src/infrastructure/dlq-router.ts::dlqRouter',
  // Validation-rig HTTP surface. The rig's own suite drives the module
  // directly, and the only build step that would have called this runs solely
  // in a `staging` environment that has no trigger.
  'src/validation-rig/router.ts::validationRigRouter',
];

describe('every router is mounted', () => {
  const found = findUnmountedRouters(process.cwd()).map(orphanKey);
  const baseline = new Set(KNOWN_UNMOUNTED_ROUTERS);

  it('adds no router that nothing mounts', () => {
    const fresh = found.filter((k) => !baseline.has(k));
    if (fresh.length > 0) {
      throw new Error(
        `${fresh.length} router(s) are declared but never mounted:\n\n`
        + fresh.map((k) => `  ${k}`).join('\n')
        + '\n\nAn unmounted router answers 404 to every caller. Callers that fail\n'
        + 'soft — a circuit breaker, a .catch() marked non-fatal — will report\n'
        + 'success while nothing happens.\n\n'
        + 'Fix it one of these ways:\n'
        + '  1. Mount it in src/index.ts, under the right SERVICE_TYPE gate.\n'
        + '  2. Delete it — a router with no mount and no caller is not a feature.\n'
        + '  3. Add it to KNOWN_UNMOUNTED_ROUTERS with a reason, if it is genuinely\n'
        + '     waiting on something. A reviewer should ask what.\n',
      );
    }
  });

  it('does not let the list rot', () => {
    const stale = [...baseline].filter((k) => !found.includes(k));
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} baseline entr(ies) are mounted now and should be removed:\n\n`
        + stale.map((k) => `  ${k}`).join('\n'),
      );
    }
  });
});
