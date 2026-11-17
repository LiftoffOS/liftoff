// Tools Registry Integration Test
//
// End-to-end check that all 10 tools register correctly and the role matrix
// filters them as the implementation plan specifies. This is the test that
// fails loudly if a future commit:
//   - Forgets to register a new tool in registerInsightsTools()
//   - Changes the role matrix without updating the test
//   - Renames a tool without updating its data-provider wiring
//
// We mock all data providers so the tests don't hit DB / Tenant Runtime,
// but we DO call dispatchToolCall() through the real dispatcher so the
// registration → role check → executor → sanitization path is exercised
// end-to-end.

jest.mock('../../data-providers', () => ({
  // Tool inputs
  getInternalAgents: jest.fn().mockResolvedValue([]),
  getAgentCosts: jest.fn().mockResolvedValue({}),
  getPerAgentAuditStats: jest.fn().mockResolvedValue({}),
  buildInternalAgentStats: jest.fn().mockReturnValue([]),
  getExternalAgentStats: jest.fn().mockResolvedValue([]),
  getAgentLLMCosts: jest.fn().mockResolvedValue([]),
  getAgentlessLLMCosts: jest.fn().mockResolvedValue([]),
  getAuditLogAggregation: jest.fn().mockResolvedValue(null),
  getInvocationStats: jest.fn().mockResolvedValue(null),
  getHitlApprovalStats: jest.fn().mockResolvedValue(null),
  getCorrectionStats: jest.fn().mockResolvedValue(null),
  getMemberActivity: jest.fn().mockResolvedValue([]),
  getOversightSettings: jest.fn().mockResolvedValue(null),
  getTenantMembers: jest.fn().mockResolvedValue([]),
  getConnectorHealth: jest.fn().mockResolvedValue(null),
  getDataLandscape: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../data-providers/sandbox-cost-provider', () => ({
  getSandboxCosts: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../data-providers/data-sources-cost-provider', () => ({
  getDataSourceCosts: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../data-providers/web-tools-cost-provider', () => ({
  getWebToolCosts: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../data-sources/service', () => ({
  getDataSources: jest.fn().mockResolvedValue({ sources: [] }),
}));
jest.mock('../../data-providers/voice-cost-provider', () => ({
  getAgentVoiceCosts: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getExternalAgentTaskCounts: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import {
  registerInsightsTools,
  dispatchToolCall,
  getToolDefinitionsForRole,
  _resetToolRegistry,
} from '../index';
import { WORKSPACE_ACTION_TOOLS } from '../../../workspace-actions/tools';

const WORKSPACE_TOOL_NAMES = new Set(WORKSPACE_ACTION_TOOLS.map((t) => t.definition.name));
import type { InsightsRole, InsightsToolContext } from '../types';

// The four browser tools are shared with Liftoff (browser-sessions/assistant-tools)
// so both platform assistants offer the same browser. A viewer gets none of them:
// a session costs money for as long as it is open.
const BROWSER_TOOL_NAMES = [
  'navigate_browser_session', 'run_browser_task',
  'start_browser_session', 'read_active_browser_session',
];

// Neither the colleague to bring in nor the three dataset tools are registered
// (the chat service answers both itself), but both are offered, so both are
// part of what a role sees. The dataset tools read back what this conversation
// already fetched, so every role gets them — a viewer included.
const DATASET_TOOL_NAMES = ['dataset_query', 'dataset_extract', 'dataset_list'];

// Reading further back in THIS conversation. Intercepted before the registry
// like the dataset tools, because a 500-character sanitizer cut would return the
// first line of a transcript and nothing else. Every role, viewer included: they
// are in the conversation and their own client renders all of it.
const RECALL_TOOL_NAMES = ['read_conversation_history', 'recall_conversations'];

const ALL_TOOL_NAMES = [
  ...DATASET_TOOL_NAMES,
  ...RECALL_TOOL_NAMES,
  ...BROWSER_TOOL_NAMES,
  'bring_in_colleague',
  // Showing a file already in the workspace. Intercepted before the registry
  // like the dataset tools beside it, for the same reason.
  'show_file',
  'get_agent_performance',
  'get_execution_trends',
  'get_cost_breakdown',
  'get_human_activity',
  'get_oversight_config',
  'get_workforce_composition',
  'get_connector_health',
  'get_data_landscape',
  'get_data_source_rates',
];

const EXPECTED_TOOLS_BY_ROLE: Record<InsightsRole, string[]> = {
  owner: [
    ...BROWSER_TOOL_NAMES,
    ...DATASET_TOOL_NAMES,
    ...RECALL_TOOL_NAMES,
    'show_file',
    'bring_in_colleague',
    'get_agent_performance', 'get_execution_trends', 'get_cost_breakdown',
    'get_human_activity',
    'get_oversight_config', 'get_workforce_composition', 'get_connector_health', 'get_data_landscape',
    'get_data_source_rates',
  ],
  admin: [
    ...BROWSER_TOOL_NAMES,
    ...DATASET_TOOL_NAMES,
    ...RECALL_TOOL_NAMES,
    'show_file',
    'bring_in_colleague',
    'get_agent_performance', 'get_execution_trends', 'get_cost_breakdown',
    'get_human_activity',
    'get_oversight_config', 'get_workforce_composition', 'get_connector_health', 'get_data_landscape',
    'get_data_source_rates',
  ],
  member: [
    ...BROWSER_TOOL_NAMES,
    ...DATASET_TOOL_NAMES,
    ...RECALL_TOOL_NAMES,
    'show_file',
    'bring_in_colleague',
    'get_agent_performance', 'get_execution_trends', 'get_cost_breakdown',
    'get_human_activity',
    'get_oversight_config', 'get_workforce_composition', 'get_connector_health', 'get_data_landscape',
    'get_data_source_rates',
  ],
  viewer: [
    ...DATASET_TOOL_NAMES,
    ...RECALL_TOOL_NAMES,
    'show_file',
    'bring_in_colleague',
    'get_agent_performance', 'get_execution_trends', 'get_cost_breakdown',
    'get_oversight_config', 'get_workforce_composition', 'get_connector_health', 'get_data_landscape',
    'get_data_source_rates',
  ],
};

beforeAll(() => {
  _resetToolRegistry();
  registerInsightsTools();
});

afterAll(() => {
  _resetToolRegistry();
});

describe('Tools registry — registration', () => {
  it('offers all 20 built-in tools, plus the shared workspace-action tools that are not the Chief AI Officer\'s', () => {
    const ownerTools = getToolDefinitionsForRole('owner');
    const builtIn = ownerTools.filter((t) => !WORKSPACE_TOOL_NAMES.has(t.name));
    expect(builtIn).toHaveLength(20);
    expect(builtIn.map(t => t.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());
    // A change to an agent is the Chief AI Officer's, whoever asks: the
    // stewarded actions are registered (one registry) but never offered here.
    for (const t of WORKSPACE_ACTION_TOOLS) {
      if (t.steward === 'caio') expect(ownerTools.map((x) => x.name)).not.toContain(t.definition.name);
      else expect(ownerTools.map((x) => x.name)).toContain(t.definition.name);
    }
  });

  it('offers an answer-only turn no mutating action, no browser and no colleague', () => {
    const names = getToolDefinitionsForRole('owner', { answerOnly: true }).map((t) => t.name);
    for (const t of WORKSPACE_ACTION_TOOLS) if (t.mutating) expect(names).not.toContain(t.definition.name);
    for (const b of ['navigate_browser_session', 'run_browser_task', 'start_browser_session', 'read_active_browser_session']) expect(names).not.toContain(b);
    expect(names).not.toContain('bring_in_colleague');
    expect(names).toContain('get_cost_breakdown');
    expect(names).toContain('team_get');
    // Reading a result this conversation already fetched changes nothing and
    // confirms nothing, so an answer-only turn keeps it.
    for (const d of DATASET_TOOL_NAMES) expect(names).toContain(d);
  });

  it('offers a hand-over everything but a colleague of its own', () => {
    const ordinary = getToolDefinitionsForRole('owner').map((t) => t.name);
    const handedOver = getToolDefinitionsForRole('owner', { asColleague: true }).map((t) => t.name);
    expect(handedOver).toEqual(ordinary.filter((n) => n !== 'bring_in_colleague'));
  });

  it('lists the colleague after the registry, as a definition the model can call by name', () => {
    const defs = getToolDefinitionsForRole('owner');
    const colleague = defs.find((d) => d.name === 'bring_in_colleague');
    // After every registered tool, so it never displaces a data tool in the
    // model's view; the dataset tools follow it for the same reason.
    expect(defs.slice(-7).map((d) => d.name))
      .toEqual(['bring_in_colleague', 'dataset_query', 'dataset_extract', 'dataset_list', 'show_file', 'read_conversation_history', 'recall_conversations']);
    expect(colleague?.input_schema).toMatchObject({
      required: ['colleague', 'request'],
      properties: { colleague: { enum: ['caio', 'liftoff'] } },
    });
  });

  it('never dispatches the colleague: the chat service hands the turn over instead', async () => {
    const ctx: InsightsToolContext = { tenantId: 'tenant-1', accountId: 'a1', role: 'owner' };
    const result = await dispatchToolCall('bring_in_colleague', { colleague: 'caio', request: 'x' }, ctx);
    expect(result.ok).toBe(false);
    expect(String(result.data.error)).toContain('Unknown tool');
  });

  it('a viewer is denied a workspace-action write at dispatch, by the shared permission', async () => {
    const ctx: InsightsToolContext = { tenantId: 'tenant-1', accountId: 'a1', role: 'viewer' };
    const result = await dispatchToolCall('review_decide', { approvalId: 'x', decision: 'approve' }, ctx);
    expect(result.ok).toBe(false);
    expect(String(result.data.error)).toContain('not available');
  });

  // Wiring guard: ensures the production server boot file actually CALLS
  // registerInsightsTools() at module load. This caught a real regression
  // where the call existed in the docs and tests but had never been added
  // to src/index.ts — the chat service ran with an empty tool registry,
  // the system prompt builder rendered "(none — the user has no data
  // access tools available)", and the LLM truthfully replied that it had
  // no tools.
  //
  // We grep the source rather than booting the whole server because
  // importing src/index.ts spins up Express + the DB pool + everything
  // else, which is too heavy for a unit test. The grep is brittle but
  // narrowly so: any future refactor that moves the call still has to
  // either import the symbol or invoke it.
  it('production boot file (src/index.ts) wires up the tool registry', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const indexSource = fs.readFileSync(
      path.join(__dirname, '../../../index.ts'),
      'utf-8',
    );
    expect(indexSource).toContain('registerInsightsTools');
    expect(indexSource).toMatch(/registerInsightsTools\s*\(\s*\)/);
  });

  it.each(['owner', 'admin', 'member', 'viewer'] as InsightsRole[])(
    '%s sees the expected tool list (matches role matrix)',
    (role) => {
      const tools = getToolDefinitionsForRole(role).map(t => t.name).filter((n) => !WORKSPACE_TOOL_NAMES.has(n));
      expect(tools.sort()).toEqual([...EXPECTED_TOOLS_BY_ROLE[role]].sort());
    },
  );
});

describe('Tools registry — dispatchable tools per role', () => {
  // Every offered tool the REGISTRY owns dispatches. Four kinds do not, and all
  // are answered by the chat service instead: the colleague (a hand-over,
  // asserted above), the three dataset tools (their prose must escape the
  // sanitizer's 500-character cut, asserted below), show_file, which is
  // intercepted for the same reason and needs the thread the registry does not
  // carry, and read_conversation_history, which needs both — its result IS a
  // transcript, and the thread it reads is the turn's.
  it.each(EXPECTED_TOOLS_BY_ROLE.owner.filter((n) => n !== 'bring_in_colleague' && n !== 'show_file' && !DATASET_TOOL_NAMES.includes(n) && !RECALL_TOOL_NAMES.includes(n)))(
    'owner can dispatch %s',
    async (toolName) => {
      const ctx: InsightsToolContext = { tenantId: 'tenant-1', accountId: 'a1', role: 'owner' };
      const result = await dispatchToolCall(toolName, { time_range: { preset: 'this_week' } }, ctx);
      expect(result.ok).toBe(true);
      expect(result.toolName).toBe(toolName);
    },
  );

  it.each(['get_human_activity'])(
    'viewer CANNOT dispatch %s (denied by role matrix)',
    async (toolName) => {
      const ctx: InsightsToolContext = { tenantId: 'tenant-1', accountId: 'a1', role: 'viewer' };
      const result = await dispatchToolCall(toolName, {}, ctx);
      expect(result.ok).toBe(false);
    },
  );

  it('viewer CAN dispatch get_agent_performance (universal access)', async () => {
    const ctx: InsightsToolContext = { tenantId: 'tenant-1', accountId: 'a1', role: 'viewer' };
    const result = await dispatchToolCall('get_agent_performance', { time_range: { preset: 'this_week' } }, ctx);
    expect(result.ok).toBe(true);
  });
});

describe('Tools registry — required time_range enforcement', () => {
  // The time-ranged tools must reject missing time_range as ok=false (not crash)
  const TIME_RANGED_TOOLS = [
    'get_agent_performance',
    'get_execution_trends',
    'get_cost_breakdown',
    'get_human_activity',
    'get_connector_health',
  ];

  it.each(TIME_RANGED_TOOLS)(
    '%s rejects missing time_range with ok=false and a clear error',
    async (toolName) => {
      const ctx: InsightsToolContext = { tenantId: 'tenant-1', accountId: 'a1', role: 'owner' };
      // Pass empty input — no time_range
      const result = await dispatchToolCall(toolName, {}, ctx);
      expect(result.ok).toBe(false);
      expect(result.data).toHaveProperty('error');
      expect(String(result.data.error)).toMatch(/time_range is required|time_range must include/);
    },
  );

  // The point-in-time tools accept empty input (they take no params)
  const POINT_IN_TIME_TOOLS = [
    'get_oversight_config',
    'get_workforce_composition',
    // The data landscape is a census of what exists NOW; asking for it over a
    // window would be asking a question the census cannot answer.
    'get_data_landscape',
  ];

  it.each(POINT_IN_TIME_TOOLS)(
    '%s accepts empty input (no time_range required, no schema params)',
    async (toolName) => {
      const ctx: InsightsToolContext = { tenantId: 'tenant-1', accountId: 'a1', role: 'owner' };
      const result = await dispatchToolCall(toolName, {}, ctx);
      expect(result.ok).toBe(true);
    },
  );

  it('point-in-time tools have empty input schemas', () => {
    for (const toolName of POINT_IN_TIME_TOOLS) {
      const def = getToolDefinitionsForRole('owner').find(d => d.name === toolName);
      expect(def).toBeDefined();
      expect(def!.input_schema.properties).toEqual({});
    }
  });

  it('time-ranged tools list time_range in their required[]', () => {
    for (const toolName of TIME_RANGED_TOOLS) {
      const def = getToolDefinitionsForRole('owner').find(d => d.name === toolName);
      expect(def).toBeDefined();
      expect(def!.input_schema.required).toContain('time_range');
    }
  });
});

describe('Tools registry — the dataset tools are the chat service\'s', () => {
  it.each(DATASET_TOOL_NAMES)('never dispatches %s through the registry', async (toolName) => {
    // Dispatching it here would put its output through sanitizeToolResult,
    // which cuts every string value at 500 characters — a 12,000-character
    // page of query rows would reach the model as a fifth of one line.
    const ctx: InsightsToolContext = { tenantId: 'tenant-1', accountId: 'a1', role: 'owner' };
    const result = await dispatchToolCall(toolName, {}, ctx);
    expect(result.ok).toBe(false);
    expect(String(result.data.error)).toContain('Unknown tool');
  });
});

describe('Tools registry — sanitization runs through dispatcher', () => {
  it('a tool returning a string with backticks comes back sanitized', async () => {
    // Use get_oversight_config since it has the simplest mock surface.
    // We override the mock to return a settings object with a malicious string.
    const { getOversightSettings } = jest.requireMock('../../data-providers');
    getOversightSettings.mockResolvedValue({
      autonomyLevel: 'balanced ```inject prompt```',
      sensitiveWorkCategories: ['<script>alert(1)</script>'],
      escalationRules: {},
    });

    const ctx: InsightsToolContext = { tenantId: 'tenant-1', accountId: 'a1', role: 'owner' };
    const result = await dispatchToolCall('get_oversight_config', {}, ctx);
    expect(result.ok).toBe(true);
    const settings = (result.data.settings ?? {}) as Record<string, unknown>;
    // The sanitizer turns ``` into ` and strips <script> tags
    expect(settings.autonomyLevel).toBe('balanced `inject prompt`');
    expect(settings.sensitiveWorkCategories).toEqual(['alert(1)']);
  });
});
