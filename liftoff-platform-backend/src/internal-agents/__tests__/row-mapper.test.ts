// Row-mapper tests — verify the JSONB `integrations` column round-trips
// the per-binding `config` field through parseIntegrations without dropping it.

import { mapInternalAgentRow } from '../row-mapper';

function baseRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    tenant_id: '00000000-0000-0000-0000-0000000000tt',
    role: 'Support Bot',
    responsibilities: 'Reply to support emails',
    integrations: [],
    pending_integrations: [],
    additional_context: null,
    summary: null,
    system_prompt: null,
    user_instructions: null,
    instructions_md: null,
    instructions: null,
    temperature: '0.3',
    status: 'active',
    current_version: 1,
    tasks_completed: 0,
    last_active: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    agent_type: 'agent',
    model_config: {},
    memory_scope: { readableLayers: ['global', 'individual'], writableLayers: ['individual'] },
    exec_config: {},
    workflow_steps: null,
    trigger_config: null,
    engine_config: { type: 'custom-loop' },
    delegates: [],
    workforce_plan_id: null,
    reviewed_at: null,
    reviewed_by: null,
    workflow_steps_hash: null,
    messaging_nickname: null,
    workflow_visualization_steps: null,
    autonomy_override: null,
    ...extra,
  };
}

describe('mapInternalAgentRow', () => {
  it('preserves IntegrationPermission.config (JSONB rides along)', () => {
    const integrations = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        type: 'google_mail',
        selectedObjects: [],
        config: { gmailQuery: 'label:support-agent', sendAs: 'support@example.com' },
      },
    ];

    const agent = mapInternalAgentRow(baseRow({ integrations }));

    expect(agent.integrations).toHaveLength(1);
    expect(agent.integrations[0]).toMatchObject({
      id: '00000000-0000-0000-0000-000000000001',
      type: 'google_mail',
      config: { gmailQuery: 'label:support-agent', sendAs: 'support@example.com' },
    });
  });

  it('handles permissions without config (config undefined)', () => {
    const integrations = [
      {
        id: '00000000-0000-0000-0000-000000000002',
        type: 'google_sheets',
        selectedObjects: ['Sheet1'],
      },
    ];

    const agent = mapInternalAgentRow(baseRow({ integrations }));

    expect(agent.integrations[0].config).toBeUndefined();
  });
});

describe('mapInternalAgentRow — modelConfig tier', () => {
  it('reads a stored pre-534 tier name as large', () => {
    // Migration 534 rewrites every stored row; this covers one it cannot reach
    // (a restored backup, a row written by an older instance mid-deploy).
    const agent = mapInternalAgentRow(baseRow({ model_config: { tier: 'flagship', maxTokens: 8000 } }));
    expect(agent.modelConfig).toEqual({ tier: 'large', maxTokens: 8000 });
  });

  it('leaves a current tier, and a config with no tier, as stored', () => {
    expect(mapInternalAgentRow(baseRow({ model_config: { tier: 'medium' } })).modelConfig).toEqual({ tier: 'medium' });
    expect(mapInternalAgentRow(baseRow({ model_config: {} })).modelConfig).toEqual({});
  });
});
