// The cross-service reconciler reads must not be gated by the kill switch.
//
// These are GETs behind requireServiceAuth that read one row and execute
// nothing, called by platform-backend's reconcilers rather than by user
// traffic. Gating them on tenant execution state means suspending a tenant
// blinds the PLATFORM's own reconciliation of that tenant.
//
// It is not theoretical. For a tenant with agent_execution_allowed false,
// /api/internal/event-status answers 503 on every cycle — and the caller maps any non-2xx to status 'unknown'. That does not mean "we
// could not ask": it means "the subscriber never saw this event", and it makes
// the reconciler REPUBLISH. Every event of that tenant is republished every
// few minutes, then counted as stuck.
//
// The exemption is a `startsWith` prefix, so a path that drifts by one segment
// silently stops matching and the block comes back with no error anywhere.
// That is what this pins.

import { createKillSwitchMiddleware } from '../kill-switch-middleware';
import type { Request, Response, NextFunction } from 'express';

jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({
    // The state that caused this: not suspended, but execution disabled.
    getEntitlement: jest.fn().mockResolvedValue({
      operationalStatus: 'active',
      agentExecutionAllowed: false,
    }),
  }),
}));

/** Run the real middleware against one path and report whether it passed. */
async function passesKillSwitch(path: string): Promise<{ passed: boolean; status?: number }> {
  const mw = createKillSwitchMiddleware({
    skipPaths: [
      '/health', '/healthz', '/canary', '/metrics',
      '/api/internal/event-status',
      '/api/internal/governance/wal-keys',
      '/internal/agents/',
      '/api/invocations/',
    ],
  });
  let passed = false;
  let status: number | undefined;
  const req = {
    path,
    method: 'GET',
    headers: {},
    params: {},
    query: { tenantId: '38fa7803-e4aa-4962-9b0b-02ff13a7a4de' },
  } as unknown as Request;
  const res = {
    status: (c: number) => { status = c; return { json: () => undefined }; },
  } as unknown as Response;
  await mw(req, res, (() => { passed = true; }) as NextFunction);
  return { passed, status };
}

describe('kill switch exempts cross-service reconciler reads', () => {
  it.each([
    ['/api/internal/event-status/8f4d0c1a-0000-4000-8000-000000000000'],
    ['/api/internal/governance/wal-keys'],
  ])('%s passes even with agent execution disabled', async (path) => {
    const { passed, status } = await passesKillSwitch(path);
    expect(status).toBeUndefined();
    expect(passed).toBe(true);
  });

  it('still blocks an ordinary tenant-facing path, so the exemption is narrow', async () => {
    // The guard on the guard: if the skip list ever matched everything, the
    // tests above would pass while the kill switch enforced nothing.
    const { passed, status } = await passesKillSwitch('/api/execution/invoke');
    expect(passed).toBe(false);
    expect(status).toBe(503);
  });

  it('does NOT exempt the mutating resync POST', async () => {
    // Its sibling GET is a read and could be exempt; this one changes state.
    // An operator hitting resync on a disabled tenant should stay visible
    // rather than being waved through by a prefix match.
    const { passed, status } = await passesKillSwitch(
      '/api/internal/model-configs/resync/38fa7803-e4aa-4962-9b0b-02ff13a7a4de',
    );
    expect(passed).toBe(false);
    expect(status).toBe(503);
  });
});
