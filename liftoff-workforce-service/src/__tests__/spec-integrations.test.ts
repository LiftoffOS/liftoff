// A plan spec's connector types have to become real bindings before distill.
//
// WorkforcePlanAgentSpec.connectors lists connector TYPE names; its contract is
// that connected ones are auto-assigned at provisioning and unconnected ones
// become pending integrations. A model cannot perform that partition — it
// cannot see which connectors a workspace has, and it cannot know connection
// ids — so integrations it supplies carry no usable `type`, and platform-backend
// reads an empty type set as "no filter" rather than "no integrations".

const listTenantConnectors = jest.fn();
jest.mock('../workforce-plans/tenant-connectors.js', () => ({ listTenantConnectors }));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resolveSpecIntegrations } from '../platform-agent/hrbp/spec-integrations.js';
import type { WorkforcePlanAgentSpec } from '../workforce-plans/types.js';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

function spec(connectors?: string[]): WorkforcePlanAgentSpec {
  return {
    specId: 'campaign-tracker',
    name: 'Campaign Tracker',
    agentType: 'agent',
    roleSummary: 'tracks campaigns',
    ...(connectors ? { connectors } : {}),
  } as WorkforcePlanAgentSpec;
}

const SHEETS = {
  id: 'conn-sheets-1',
  tenantId: TENANT,
  type: 'google_sheets',
  name: 'google_sheets',
  displayName: 'Google Sheets',
  status: 'active' as const,
};

beforeEach(() => jest.clearAllMocks());

describe('resolveSpecIntegrations', () => {
  it('turns a connector type into a binding carrying a real connection id', async () => {
    listTenantConnectors.mockResolvedValue({ ok: true, connectors: [SHEETS] });

    const result = await resolveSpecIntegrations(TENANT, spec(['google_sheets']));

    expect(result.lookupSucceeded).toBe(true);
    expect(result.integrations).toEqual([
      // selectedObjects is required on platform-backend's IntegrationInfo and
      // dereferenced there; omitting it threw a TypeError out of distill and
      // came back as a bare 500.
      { id: 'conn-sheets-1', type: 'google_sheets', name: 'Google Sheets', selectedObjects: [] },
    ]);
    expect(result.pendingConnectorTypes).toEqual([]);
  });

  it('emits every field platform-backend dereferences, not just the ones it reads softly', async () => {
    listTenantConnectors.mockResolvedValue({ ok: true, connectors: [SHEETS] });

    const { integrations } = await resolveSpecIntegrations(TENANT, spec(['google_sheets']));

    for (const i of integrations) {
      expect(Array.isArray(i.selectedObjects)).toBe(true);
    }
  });

  it('emits a usable `type` — the field whose absence caused the failure', async () => {
    listTenantConnectors.mockResolvedValue({ ok: true, connectors: [SHEETS] });

    const { integrations } = await resolveSpecIntegrations(TENANT, spec(['google_sheets']));

    // platform-backend filters manifests by integration type. An entry without
    // one is dropped, the type set empties, and distill used to fall back to
    // the whole workspace.
    expect(integrations.every(i => typeof i.type === 'string' && i.type.length > 0)).toBe(true);
  });

  it('lists a requested-but-unconnected type as pending instead of binding it', async () => {
    listTenantConnectors.mockResolvedValue({ ok: true, connectors: [SHEETS] });

    const result = await resolveSpecIntegrations(TENANT, spec(['google_sheets', 'hubspot']));

    expect(result.integrations.map(i => i.type)).toEqual(['google_sheets']);
    expect(result.pendingConnectorTypes).toEqual(['hubspot']);
  });

  it('binds one connection per type, not every connection of that type', async () => {
    listTenantConnectors.mockResolvedValue({
      ok: true,
      connectors: [SHEETS, { ...SHEETS, id: 'conn-sheets-2', displayName: 'Sheets (second)' }],
    });

    const { integrations } = await resolveSpecIntegrations(TENANT, spec(['google_sheets']));

    // Binding both would widen the agent's reach past what was approved.
    expect(integrations).toHaveLength(1);
    expect(integrations[0].id).toBe('conn-sheets-1');
  });

  it('reports a failed connector lookup rather than binding nothing silently', async () => {
    listTenantConnectors.mockResolvedValue({ ok: false, reason: 'HTTP 401' });

    const result = await resolveSpecIntegrations(TENANT, spec(['google_sheets']));

    expect(result.lookupSucceeded).toBe(false);
    expect(result.integrations).toEqual([]);
    expect(result.pendingConnectorTypes).toEqual(['google_sheets']);
  });

  it('does not call the connector service for a spec with no connectors', async () => {
    const result = await resolveSpecIntegrations(TENANT, spec());

    expect(listTenantConnectors).not.toHaveBeenCalled();
    expect(result).toEqual({ integrations: [], pendingConnectorTypes: [], lookupSucceeded: true });
  });
});
