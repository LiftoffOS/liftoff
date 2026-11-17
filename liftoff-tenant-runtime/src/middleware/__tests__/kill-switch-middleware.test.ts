// Kill-switch middleware decides whether a request is allowed through based
// on the tenant's entitlement record. The kill-switch admin endpoints on
// platform-backend mutate exactly tenantOperationalStatus + agentExecutionAllowed
// and publish tenant.suspended / tenant.reactivated, so the entitlement cache
// is the authoritative source. There is no separate "explicit kill switch"
// endpoint to query.

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockGetEntitlement = jest.fn();
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getEntitlement: mockGetEntitlement }),
}));

import {
  checkKillSwitchStatus,
  clearKillSwitchCache,
} from '../kill-switch-middleware';

const TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

describe('checkKillSwitchStatus', () => {
  beforeEach(() => {
    mockGetEntitlement.mockReset();
    clearKillSwitchCache(TENANT_ID);
  });

  it('returns active=true with "Tenant suspended" reason when operationalStatus is suspended', async () => {
    mockGetEntitlement.mockResolvedValue({
      operationalStatus: 'suspended',
      agentExecutionAllowed: false,
    });

    const status = await checkKillSwitchStatus(TENANT_ID, { enableCache: false });

    expect(status.active).toBe(true);
    expect(status.reason).toBe('Tenant suspended');
  });

  it('returns active=true with "Agent execution disabled" when only agentExecutionAllowed is false', async () => {
    mockGetEntitlement.mockResolvedValue({
      operationalStatus: 'active',
      agentExecutionAllowed: false,
    });

    const status = await checkKillSwitchStatus(TENANT_ID, { enableCache: false });

    expect(status.active).toBe(true);
    expect(status.reason).toBe('Agent execution disabled');
  });

  it('returns active=false for a healthy tenant without calling any remote service', async () => {
    mockGetEntitlement.mockResolvedValue({
      operationalStatus: 'active',
      agentExecutionAllowed: true,
    });
    const fetchSpy = jest.spyOn(global, 'fetch' as never).mockImplementation((() => {
      throw new Error('fetch must not be called — entitlement is the source of truth');
    }) as never);

    try {
      const status = await checkKillSwitchStatus(TENANT_ID, { enableCache: false });
      expect(status.active).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('caches a healthy result so repeat checks within the TTL skip entitlement lookups', async () => {
    mockGetEntitlement.mockResolvedValue({
      operationalStatus: 'active',
      agentExecutionAllowed: true,
    });

    const first = await checkKillSwitchStatus(TENANT_ID);
    const second = await checkKillSwitchStatus(TENANT_ID);

    expect(first.active).toBe(false);
    expect(second.active).toBe(false);
    expect(mockGetEntitlement).toHaveBeenCalledTimes(1);
  });
});

// ── Blocking behaviour ─────────────────────────────────────────────────────
//
// Two defects behind spurious 503s on GET /internal/agents/list-mappings for
// execution-disabled tenants.

import { createKillSwitchMiddleware } from '../kill-switch-middleware';
import { logger } from '../../infrastructure/logging';
import type { Request, Response, NextFunction } from 'express';

function reqFor(path: string, query: Record<string, string> = {}): Request {
  return { path, method: 'GET', query, params: {}, body: {}, headers: {} } as unknown as Request;
}

function resSpy(): Response & { statusCode?: number } {
  const res: Record<string, unknown> = {};
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = () => res;
  return res as Response & { statusCode?: number };
}

describe('kill-switch blocking', () => {
  beforeEach(() => {
    mockGetEntitlement.mockReset();
    clearKillSwitchCache(TENANT_ID);
    (logger.warn as jest.Mock).mockReset();
    mockGetEntitlement.mockResolvedValue({
      operationalStatus: 'active',
      agentExecutionAllowed: false,
    });
  });

  it('does not block the agent id-space mapping reads', async () => {
    // The cost-attribution ingesters call these for every tenant with usage to
    // attribute, including tenants whose execution has been disabled. Blocking
    // them made the caller fall back to pass-through id translation, which
    // writes runtime ids into a column that must hold internal_agents.id.
    const mw = createKillSwitchMiddleware({
      skipPaths: ['/health', '/internal/agents/'],
      enableCache: false,
    });
    const res = resSpy();
    let passed = false;

    await mw(reqFor('/internal/agents/list-mappings', { tenantId: TENANT_ID }), res, (() => {
      passed = true;
    }) as NextFunction);

    expect(passed).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  it('still blocks a non-exempt path for the same tenant', async () => {
    const mw = createKillSwitchMiddleware({
      skipPaths: ['/health', '/internal/agents/'],
      enableCache: false,
    });
    const res = resSpy();
    let passed = false;

    await mw(reqFor('/api/v1/execute', { tenantId: TENANT_ID }), res, (() => {
      passed = true;
    }) as NextFunction);

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(503);
  });

  it('names the blocked tenant in the log', async () => {
    // The tenant arrives as a query parameter, which is what the extractor that
    // DECIDES the block reads. The log used to read the x-tenant-id header, so
    // every block reported an undefined tenant.
    const mw = createKillSwitchMiddleware({ skipPaths: ['/health'], enableCache: false });

    await mw(reqFor('/api/v1/execute', { tenantId: TENANT_ID }), resSpy(), (() => {}) as NextFunction);

    expect(logger.warn).toHaveBeenCalledWith(
      'Request blocked by kill switch',
      expect.objectContaining({ tenantId: TENANT_ID }),
    );
  });
});

describe('the wiring in index.ts', () => {
  // The tests above pass skipPaths explicitly, which proves the middleware
  // honours an exemption but not that the running service declares one. This
  // reads the actual mount so the exemption cannot be silently dropped.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'index.ts'),
    'utf8',
  ) as string;

  it('exempts the agent id-space mapping router', () => {
    const skipBlock = src.slice(
      src.indexOf('createKillSwitchMiddleware({'),
      src.indexOf('createKillSwitchMiddleware({') + 3000,
    );
    expect(skipBlock).toMatch(/'\/internal\/agents\/'/);
  });

  it('does not blanket-exempt every internal surface', () => {
    // Deliberate: /api/internal/wakes and /api/instruction-compiler carry no
    // in-file service-auth guard, so a blanket '/internal' or '/api/internal'
    // exemption would widen what an unauthenticated caller can reach. The
    // exemption is per-router and stays that way.
    const skipBlock = src.slice(
      src.indexOf('createKillSwitchMiddleware({'),
      src.indexOf('createKillSwitchMiddleware({') + 3000,
    );
    expect(skipBlock).not.toMatch(/'\/internal',/);
    expect(skipBlock).not.toMatch(/'\/api\/internal',/);
  });
});
