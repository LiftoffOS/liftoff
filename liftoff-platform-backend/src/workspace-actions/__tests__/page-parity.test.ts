// A tool that says it is a page shows what the page shows.
//
// `connections_list` and `knowledge_list` are the assistants' view of
// /dashboard/connections and /dashboard/knowledge. Each is a hand-written
// builder, each claims the page in its own description, and each had drifted —
// in opposite directions, which is why one test covers both.
//
// How each drift shows up:
//
//   - connections: a view carrying EVERY connector row with its raw status lets
//     the assistant tell the person some connections were "started but never
//     finished", then send them to the Connections page to finish them. The page
//     renders `active` and `error` only (plus a GitHub install awaiting an
//     organisation owner), so those rows appear nowhere and the advice is a
//     dead end.
//   - knowledge: a view carrying the extraction failure and NOT `syncError` lets
//     the assistant say "The library does not record why it failed" about a row
//     whose reason the Knowledge page shows in a tooltip on the same screen.
//
// Showing more than the page invents state the person cannot act on. Showing
// less contradicts what they are looking at. The assertions below are the page's
// own rules, written out, so either drift fails here.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../internal-agents/service', () => ({ internalAgentService: { getById: jest.fn(), listAllByTenant: jest.fn() } }));
jest.mock('../../external-agents/service', () => ({ externalAgentService: { listAllByTenant: jest.fn() } }));

const mockListConnectors = jest.fn();
const mockGetCatalog = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  listConnectorsForTenant: (...a: unknown[]) => mockListConnectors(...a),
  getCatalog: (...a: unknown[]) => mockGetCatalog(...a),
  getConnectorHealthStats: jest.fn().mockRejectedValue(new Error('no health in this test')),
}));
jest.mock('../../custom-mcp-servers/service', () => ({ customMcpServerService: { list: jest.fn().mockResolvedValue([]) } }));

const mockListItems = jest.fn();
jest.mock('../../knowledge/service', () => ({
  listItems: (...a: unknown[]) => mockListItems(...a),
  browseConnector: jest.fn(),
  createItem: jest.fn(),
  getById: jest.fn(),
  extractAndPersistItem: jest.fn(),
}));

import { listConnections } from '../connections';
import { listKnowledge } from '../knowledge';
import type { Actor } from '../actor';

const actor: Actor = {
  tenantId: '22222222-2222-2222-2222-222222222222',
  accountId: 'acct-1',
  role: 'owner',
  displayName: 'Ada',
  surface: 'liftoff',
};

function connector(over: Partial<{ id: string; type: string; name: string; status: string; installState: string | null }>) {
  return { id: 'c-1', type: 'workday', name: 'Workday', status: 'active', installState: null, ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCatalog.mockResolvedValue({ connectors: [
    { type: 'workday', displayName: 'Workday', category: 'hris', status: 'available', auth: { kind: 'api_key' } },
    { type: 'google_bigquery', displayName: 'BigQuery', category: 'data', status: 'available', auth: { kind: 'iam_grant' } },
    { type: 'github', displayName: 'GitHub', category: 'engineering', status: 'available', auth: { kind: 'github_app' } },
    { type: 'slack', displayName: 'Slack', category: 'messaging', status: 'available', auth: { kind: 'static_oauth' } },
  ] });
});

describe('connections_list shows what the Connections page shows', () => {
  it('lists a connector the page renders, and no other', async () => {
    // A realistic workspace shape: a few real connections, a pile of
    // disconnected rows, and three abandoned setups.
    mockListConnectors.mockResolvedValue([
      connector({ id: 'a-1', type: 'slack', name: 'Slack', status: 'active' }),
      connector({ id: 'a-2', type: 'github', name: 'GitHub (acme)', status: 'error' }),
      connector({ id: 'd-1', type: 'slack', name: 'Slack', status: 'disconnected' }),
      connector({ id: 'd-2', type: 'workday', name: 'Workday', status: 'disconnected' }),
      connector({ id: 'p-1', type: 'workday', name: 'Workday (730793)', status: 'pending' }),
      connector({ id: 'p-2', type: 'workday', name: 'Workday (884120)', status: 'pending' }),
      connector({ id: 'p-3', type: 'google_bigquery', name: 'BigQuery', status: 'pending' }),
    ]);

    const view = await listConnections(actor);

    // active and error: the two the page calls connected (error renders as
    // "needs reconnect", which is still a connection the person has).
    expect(view.connected.map((c) => c.id).sort()).toEqual(['a-1', 'a-2']);
    // Everything else is absent, not merely marked. A row the page never draws
    // is not the person's business, and reporting one sends them looking for it.
    const shown = JSON.stringify(view.connected) + JSON.stringify(view.awaitingOrgApproval);
    for (const invisible of ['d-1', 'd-2', 'p-1', 'p-2', 'p-3']) {
      expect(shown).not.toContain(invisible);
    }
  });

  it('keeps the one unfinished state the page does draw: an install awaiting an organisation owner', async () => {
    mockListConnectors.mockResolvedValue([
      connector({ id: 'g-1', type: 'github', name: 'GitHub', status: 'pending', installState: 'awaiting_org_approval' }),
      connector({ id: 'p-1', type: 'workday', status: 'pending', installState: null }),
    ]);

    const view = await listConnections(actor);

    expect(view.connected).toEqual([]);
    expect(view.awaitingOrgApproval.map((c) => c.id)).toEqual(['g-1']);
    // A pending row with no install state is still nowhere, which is the whole
    // distinction: one is a request a vendor is holding, the other is a setup
    // that was abandoned and is finished by starting again.
    expect(JSON.stringify(view.awaitingOrgApproval)).not.toContain('p-1');
  });

  it('leaves an unfinished app under available, where the page leaves it', async () => {
    mockListConnectors.mockResolvedValue([connector({ id: 'p-1', type: 'workday', status: 'pending' })]);
    const view = await listConnections(actor);
    // Which is what makes "connect it with connection_start" the true answer.
    expect(view.available.map((a) => a.type)).toContain('workday');
  });
});

describe('knowledge_list shows what the Knowledge page shows', () => {
  function item(over: Record<string, unknown> = {}) {
    return {
      id: 'k-1',
      tenantId: actor.tenantId,
      title: 'Shawkat (Papr.ai) 4/20/26',
      sourceUrl: 'https://docs.google.com/document/d/EXAMPLE_DOC_ID',
      connectorId: 'conn-1',
      connectorType: 'google_drive',
      externalId: 'file-1',
      contentType: 'document',
      excerpt: null,
      metadata: {},
      importMode: 'file_select',
      syncStatus: 'synced',
      lastSyncedAt: '2026-08-16T02:18:34.561Z',
      syncError: null,
      parentId: null,
      extractionStatus: 'done',
      extractedText: 'text',
      extractedAt: '2026-08-16T02:18:34.561Z',
      createdAt: '2026-08-16T02:00:00.000Z',
      updatedAt: '2026-08-16T02:18:34.561Z',
      ...over,
    };
  }

  it('carries the reason an entry could not be read, which the page shows in a tooltip', async () => {
    const reason =
      'This file contains only its title, so there is nothing to read. '
      + 'Its content may live in the tool that created it rather than in the file.';
    mockListItems.mockResolvedValue([item({ extractionStatus: 'error', extractedText: '', syncError: reason })]);

    const view = await listKnowledge(actor);

    expect(view.items[0]!.extractionStatus).toBe('error');
    // The field whose absence produced "The library does not record why it
    // failed" in front of a person who could read the reason on their own screen.
    expect(view.items[0]!.syncError).toBe(reason);
  });

  it('carries the connector the entry came from, so it can be read again rather than added twice', async () => {
    mockListItems.mockResolvedValue([item()]);
    const view = await listKnowledge(actor);
    expect(view.items[0]!.connectorId).toBe('conn-1');
    expect(view.items[0]!.connectorType).toBe('google_drive');
  });

  it('says nothing about a reason when there is none', async () => {
    mockListItems.mockResolvedValue([item()]);
    const view = await listKnowledge(actor);
    expect(view.items[0]!.syncError).toBeNull();
  });
});
