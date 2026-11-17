// connectors__list_available must report what the platform supports and what
// the tenant actually has, and must never turn either lookup's failure into a
// denial.
//
// Two customer-facing failures came out of the same hardcoded 52-entry array.
// First, a connected app absent from the snapshot was dropped with no trace: a
// workspace whose Connections page showed twelve was told it had seven, because
// Apollo, Exa, Tavily, Anchor Browser and an MCP server were not in the list.
// That was fixed on the CONNECTED side in 11a2a8c. The AVAILABLE side stayed
// broken, and three weeks later the CAIO told a customer "We do not have a
// webclaw connector" about an entry that had been available for nearly three
// months. There is now no hand-written connector list in this repo at all.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockListByTenant = jest.fn();
jest.mock('../workforce-plans/tenant-connectors.js', () => ({
  workforcePlansConnectorClient: { listByTenant: (...a: unknown[]) => mockListByTenant(...a) },
}));

const mockFetchCatalog = jest.fn();
jest.mock('../workforce-plans/connector-catalog.js', () => ({
  fetchConnectorCatalog: (...a: unknown[]) => mockFetchCatalog(...a),
}));

import { connectorsListAvailableTool } from '../workforce-plans/tools/connectors-list-available.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

const ctx: WorkforcePlanToolContext = {
  tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
  accountId: 'acc-1',
  role: 'owner',
};

type Output = {
  connectors: Array<{
    type: string;
    name: string;
    category: string;
    connected?: boolean;
    connectionStatus?: string;
  }>;
  connectedCount: number;
  availableCount: number;
  catalogSource: string;
  catalogComplete: boolean;
  connectionsKnown: boolean;
  message: string;
};

/** A stand-in for the live catalog. The real one carries ~160 available entries. */
const CATALOG = [
  { type: 'google_mail', displayName: 'Gmail', category: 'productivity' },
  { type: 'github', displayName: 'GitHub', category: 'engineering' },
  { type: 'webclaw', displayName: 'WebClaw', category: 'web_tools' },
  { type: 'firecrawl', displayName: 'Firecrawl', category: 'web_tools' },
];

const run = () =>
  connectorsListAvailableTool.execute({}, ctx) as unknown as Promise<Output>;

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchCatalog.mockResolvedValue({ source: 'live', connectors: CATALOG });
  mockListByTenant.mockResolvedValue({ ok: true, connectors: [] });
});

describe('connectors__list_available', () => {
  it('reports a supported but unconnected connector as available, not absent', async () => {
    // The webclaw regression. It must appear, and it must appear as something
    // the user can go and connect.
    const out = await run();

    const webclaw = out.connectors.find(c => c.type === 'webclaw');
    expect(webclaw).toBeDefined();
    expect(webclaw?.connected).toBe(false);
    expect(webclaw?.name).toBe('WebClaw');
    expect(out.catalogSource).toBe('live');
    expect(out.catalogComplete).toBe(true);
  });

  it('takes the whole catalog from the live source, not a local list', async () => {
    mockFetchCatalog.mockResolvedValue({
      source: 'live',
      connectors: [{ type: 'brand_new_app', displayName: 'Brand New App', category: 'crm' }],
    });

    const out = await run();

    expect(out.connectors.map(c => c.type)).toEqual(['brand_new_app']);
    expect(out.availableCount).toBe(1);
  });

  it('uses the catalog display name rather than a local brand-name table', async () => {
    // A DISPLAY_NAME_OVERRIDES map used to live in the tool, duplicating the
    // displayName the catalog already returns. Removing it is only safe if the
    // catalog's label is what reaches the CAIO.
    const out = await run();
    expect(out.connectors.find(c => c.type === 'google_mail')?.name).toBe('Gmail');
  });

  it('reports connected apps that the catalog does not describe', async () => {
    mockListByTenant.mockResolvedValue({
      ok: true,
      connectors: [
        { id: '1', tenantId: ctx.tenantId, type: 'google_mail', name: 'Gmail', displayName: 'Gmail', status: 'active' },
        { id: '2', tenantId: ctx.tenantId, type: 'apollo', name: 'Apollo', displayName: 'Apollo.io', status: 'active' },
      ],
    });

    const out = await run();

    const connected = out.connectors.filter(c => c.connected).map(c => c.type).sort();
    expect(connected).toEqual(['apollo', 'google_mail']);
    expect(out.connectedCount).toBe(2);
    expect(out.connectors.find(c => c.type === 'apollo')?.name).toBe('Apollo.io');
  });

  it('does not double-count an app that is in the catalog', async () => {
    mockListByTenant.mockResolvedValue({
      ok: true,
      connectors: [
        { id: '1', tenantId: ctx.tenantId, type: 'github', name: 'GitHub', displayName: 'GitHub', status: 'active' },
      ],
    });

    const out = await run();

    expect(out.connectors.filter(c => c.type === 'github')).toHaveLength(1);
    expect(out.connectedCount).toBe(1);
  });

  describe('when the catalog is stale rather than absent', () => {
    it('serves the full last-known-good list and says how old it is', async () => {
      mockFetchCatalog.mockResolvedValue({
        source: 'last_known_good',
        connectors: CATALOG,
        ageMs: 3 * 60 * 60 * 1000,
        reason: 'ECONNREFUSED',
      });

      const out = await run();

      // The whole catalog is still there, not a hand-written subset.
      expect(out.connectors.map(c => c.type)).toEqual(CATALOG.map(c => c.type));
      expect(out.catalogSource).toBe('last_known_good');
      expect(out.catalogComplete).toBe(false);
      expect(out.message).toMatch(/3 hours ago/);
      expect(out.message).toMatch(/say you could not confirm it/i);
    });

    it('renders a recent staleness in minutes', async () => {
      mockFetchCatalog.mockResolvedValue({
        source: 'last_known_good',
        connectors: CATALOG,
        ageMs: 12 * 60 * 1000,
        reason: 'timeout',
      });

      expect((await run()).message).toMatch(/12 minutes ago/);
    });
  });

  it('says the list does not describe the platform when no catalog was ever read', async () => {
    mockFetchCatalog.mockResolvedValue({ source: 'unavailable', reason: 'ECONNREFUSED' });
    mockListByTenant.mockResolvedValue({
      ok: true,
      connectors: [
        { id: '1', tenantId: ctx.tenantId, type: 'github', name: 'GitHub', displayName: 'GitHub', status: 'active' },
      ],
    });

    const out = await run();

    expect(out.catalogSource).toBe('unavailable');
    expect(out.catalogComplete).toBe(false);
    expect(out.message).toMatch(/does NOT describe what the platform supports/);
    // Only what the tenant has connected survives, and it is labelled as such.
    expect(out.connectors.map(c => c.type)).toEqual(['github']);
  });

  it('says it could not check connections rather than reporting an empty workspace', async () => {
    mockListByTenant.mockResolvedValue({ ok: false, reason: 'HTTP 401' });

    const out = await run();

    expect(out.connectionsKnown).toBe(false);
    expect(out.connectedCount).toBe(0);
    expect(out.message).toMatch(/could not be read/i);
    expect(out.message).not.toMatch(/no connectors are connected/i);
  });

  it('omits the connected flag entirely when connections are unknown', async () => {
    // An unknown connection state rendered as `connected: false` is the same
    // defect as an absent connector: a guess wearing a fact's clothes.
    mockListByTenant.mockResolvedValue({ ok: false, reason: 'HTTP 401' });

    const out = await run();

    expect(out.connectors.length).toBeGreaterThan(0);
    for (const entry of out.connectors) {
      expect(entry).not.toHaveProperty('connected');
    }
  });

  it('still reports a genuinely empty workspace as empty', async () => {
    const out = await run();

    expect(out.connectionsKnown).toBe(true);
    expect(out.connectedCount).toBe(0);
    expect(out.message).toMatch(/no connectors are connected/i);
  });

  it('counts against the catalog size, not against a local snapshot', async () => {
    mockListByTenant.mockResolvedValue({
      ok: true,
      connectors: [
        { id: '1', tenantId: ctx.tenantId, type: 'github', name: 'GitHub', displayName: 'GitHub', status: 'active' },
      ],
    });

    const out = await run();

    expect(out.message).toContain(`1 of ${CATALOG.length} supported connectors are connected`);
    expect(out.availableCount).toBe(CATALOG.length - 1);
  });
});
