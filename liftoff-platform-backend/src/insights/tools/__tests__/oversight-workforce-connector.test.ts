// Tests for the three commit-6 tools:
//   - get_oversight_config (point-in-time)
//   - get_workforce_composition (point-in-time)
//   - get_connector_health (time-ranged with comparison)

jest.mock('../../data-providers', () => ({
  getOversightSettings: jest.fn(),
  getInternalAgents: jest.fn(),
  getExternalAgentStats: jest.fn(),
  getTenantMembers: jest.fn(),
  getConnectorHealth: jest.fn(),
}));

import {
  getOversightSettings,
  getInternalAgents,
  getExternalAgentStats,
  getTenantMembers,
  getConnectorHealth,
} from '../../data-providers';
import { getOversightConfigTool } from '../oversight-config';
import { getWorkforceCompositionTool } from '../workforce-composition';
import { getConnectorHealthTool } from '../connector-health';
import type { InsightsToolContext } from '../types';
import type { OversightSettings, TenantMemberInfo, ExternalAgentStats, ConnectorHealthEntry } from '../../types';

const ownerCtx: InsightsToolContext = {
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'owner',
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── get_oversight_config ───────────────────────────────────────────────

describe('get_oversight_config tool', () => {
  it('exposes definition with empty schema (no params)', () => {
    expect(getOversightConfigTool.definition.name).toBe('get_oversight_config');
    expect(getOversightConfigTool.definition.input_schema.properties).toEqual({});
  });

  it('returns settings when configured', async () => {
    const fakeSettings: OversightSettings = {
      autonomyLevel: 'balanced',
      sensitiveWorkCategories: ['external_communication', 'financial'],
      escalationRules: { escalation: { policy: 'tier_1' }, communication: 'inline' },
    };
    (getOversightSettings as jest.Mock).mockResolvedValue(fakeSettings);

    const result = await getOversightConfigTool.execute({}, ownerCtx);
    expect(result.settings).toEqual(fakeSettings);
  });

  it('returns null settings when none configured', async () => {
    (getOversightSettings as jest.Mock).mockResolvedValue(null);
    const result = await getOversightConfigTool.execute({}, ownerCtx);
    expect(result.settings).toBeNull();
  });

  it('passes tenant id to provider', async () => {
    (getOversightSettings as jest.Mock).mockResolvedValue(null);
    await getOversightConfigTool.execute({}, ownerCtx);
    expect(getOversightSettings).toHaveBeenCalledWith('tenant-1');
  });
});

// ─── get_workforce_composition ──────────────────────────────────────────

describe('get_workforce_composition tool', () => {
  beforeEach(() => {
    (getInternalAgents as jest.Mock).mockResolvedValue([
      { id: 'a1', name: 'Sales Sync', role: 'sales_sync', status: 'active' },
      { id: 'a2', name: 'Inbox Triage', role: 'inbox_triage', status: 'active' },
    ]);
    (getExternalAgentStats as jest.Mock).mockResolvedValue([
      { agentId: 'e1', agentName: 'Stripe', costType: 'per_month', costAmount: 50, taskCount: 0, computedCostUsd: 50 },
    ] as ExternalAgentStats[]);
    (getTenantMembers as jest.Mock).mockResolvedValue([
      { accountId: 'm1', displayName: 'Alice', email: 'a@x', role: 'owner' },
      { accountId: 'm2', displayName: 'Bob', email: 'b@x', role: 'admin' },
    ] as TenantMemberInfo[]);
  });

  it('exposes definition with empty schema', () => {
    expect(getWorkforceCompositionTool.definition.name).toBe('get_workforce_composition');
    expect(getWorkforceCompositionTool.definition.input_schema.properties).toEqual({});
  });

  it('returns combined internal agents + external agents + members', async () => {
    const result = await getWorkforceCompositionTool.execute({}, ownerCtx);
    expect(result.internalAgents).toHaveLength(2);
    expect(result.externalAgents).toHaveLength(1);
    expect(result.members).toHaveLength(2);
  });

  it('computes correct totals', async () => {
    const result = await getWorkforceCompositionTool.execute({}, ownerCtx);
    expect(result.totals).toEqual({
      totalInternalAgents: 2,
      totalExternalAgents: 1,
      totalMembers: 2,
      totalWorkforce: 5,
    });
  });

  it('strips taskCount from external agents (composition, not activity)', async () => {
    const result = await getWorkforceCompositionTool.execute({}, ownerCtx);
    expect(result.externalAgents[0]).toEqual({
      agentId: 'e1',
      agentName: 'Stripe',
      costType: 'per_month',
      costAmount: 50,
    });
    expect((result.externalAgents[0] as Record<string, unknown>).taskCount).toBeUndefined();
  });

  it('passes empty task counts and 30-day window to external agent stats', async () => {
    await getWorkforceCompositionTool.execute({}, ownerCtx);
    expect(getExternalAgentStats).toHaveBeenCalledWith('tenant-1', {}, 30);
  });
});

// ─── get_connector_health ───────────────────────────────────────────────

describe('get_connector_health tool', () => {
  const fakeConnectors: ConnectorHealthEntry[] = [
    { connector: 'gmail', totalActions: 100, successCount: 95, failureCount: 5, avgDurationMs: 1200, errorRate: 0.05 },
    { connector: 'slack', totalActions: 50, successCount: 50, failureCount: 0, avgDurationMs: 800, errorRate: 0 },
  ];

  beforeEach(() => {
    (getConnectorHealth as jest.Mock).mockResolvedValue(fakeConnectors);
  });

  it('exposes definition with time_range and compare_to', () => {
    expect(getConnectorHealthTool.definition.name).toBe('get_connector_health');
    expect(getConnectorHealthTool.definition.input_schema.properties).toHaveProperty('time_range');
    expect(getConnectorHealthTool.definition.input_schema.properties).toHaveProperty('compare_to');
  });

  it('returns connector list for the requested period', async () => {
    const result = await getConnectorHealthTool.execute({ time_range: { preset: 'this_week' } }, ownerCtx);
    expect(result.current.connectors).toEqual(fakeConnectors);
    expect(result.current.period).toBeDefined();
  });

  it('passes null connectors through (Tenant Runtime unreachable)', async () => {
    (getConnectorHealth as jest.Mock).mockResolvedValue(null);
    const result = await getConnectorHealthTool.execute({ time_range: { preset: 'this_week' } }, ownerCtx);
    expect(result.current.connectors).toBeNull();
  });

  it('expands comparison when compare_to is provided', async () => {
    const result = await getConnectorHealthTool.execute(
      {
        time_range: { preset: 'this_week' },
        compare_to: { preset: 'last_week' },
      },
      ownerCtx,
    );
    expect(result.comparison).toBeDefined();
    expect(getConnectorHealth).toHaveBeenCalledTimes(2);
  });
});
