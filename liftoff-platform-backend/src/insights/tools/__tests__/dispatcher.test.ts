// Dispatcher tests — verifies the tool registry, role-filtered dispatch,
// sanitization, and error wrapping. Uses synthetic test tools registered
// fresh for each test so we don't depend on any real tool implementations.

import {
  dispatchToolCall,
  getToolDefinitionsForRole,
  registerTool,
  _resetToolRegistry,
} from '../dispatcher';
import type { InsightsTool, InsightsToolContext } from '../types';

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { logAudit } from '../../../infrastructure/logging';

const ownerCtx: InsightsToolContext = {
  tenantId: 'tenant-1',
  accountId: 'account-1',
  role: 'owner',
};

const viewerCtx: InsightsToolContext = {
  tenantId: 'tenant-1',
  accountId: 'account-2',
  role: 'viewer',
};

function makeTool(
  name: string,
  execute: InsightsTool['execute'] = async () => ({ ok: true }),
): InsightsTool {
  return {
    definition: {
      name,
      description: `Test tool ${name}`,
      input_schema: { type: 'object', properties: {} },
    },
    execute,
  };
}

beforeEach(() => {
  _resetToolRegistry();
  jest.clearAllMocks();
});

describe('registerTool', () => {
  it('registers a tool that becomes findable in the role list', () => {
    registerTool(makeTool('get_agent_performance'));
    expect(getToolDefinitionsForRole('owner').map(d => d.name)).toContain('get_agent_performance');
  });

  it('throws on duplicate registration', () => {
    registerTool(makeTool('get_agent_performance'));
    expect(() => registerTool(makeTool('get_agent_performance'))).toThrow(/already registered/);
  });
});

describe('getToolDefinitionsForRole', () => {
  it('filters out tools the role cannot call', () => {
    registerTool(makeTool('get_human_activity')); // viewer can't call this
    registerTool(makeTool('get_agent_performance')); // viewer can call this
    const viewerTools = getToolDefinitionsForRole('viewer').map(d => d.name);
    expect(viewerTools).toContain('get_agent_performance');
    expect(viewerTools).not.toContain('get_human_activity');
  });

  it('offers the colleague and the dataset tools when the registry is empty', () => {
    // Neither is a registered tool: both are offered whenever the role matrix
    // allows them, registry or no registry, because the chat service answers
    // both itself. The dataset tools are dispatched there rather than here so
    // their prose escapes the sanitizer's 500-character cut, which would
    // reduce a page of query rows to a fifth of one line.
    expect(getToolDefinitionsForRole('owner').map((d) => d.name))
      .toEqual(['bring_in_colleague', 'dataset_query', 'dataset_extract', 'dataset_list', 'show_file', 'read_conversation_history', 'recall_conversations']);
    expect(getToolDefinitionsForRole('owner', { asColleague: true }).map((d) => d.name))
      .toEqual(['dataset_query', 'dataset_extract', 'dataset_list', 'show_file', 'read_conversation_history', 'recall_conversations']);
  });
});

describe('dispatchToolCall', () => {
  it('calls the executor with input + ctx and returns sanitized data', async () => {
    const execute = jest.fn().mockResolvedValue({ agentName: 'Top ```inject``` Agent' });
    registerTool({
      definition: {
        name: 'get_agent_performance',
        description: '',
        input_schema: { type: 'object', properties: {} },
      },
      execute,
    });

    const result = await dispatchToolCall('get_agent_performance', { foo: 'bar' }, ownerCtx);

    expect(execute).toHaveBeenCalledWith({ foo: 'bar' }, ownerCtx);
    expect(result.ok).toBe(true);
    expect(result.toolName).toBe('get_agent_performance');
    // Sanitization stripped the fences
    expect(result.data).toEqual({ agentName: 'Top `inject` Agent' });
  });

  it('returns ok=false for unknown tool name', async () => {
    const result = await dispatchToolCall('get_world_domination', {}, ownerCtx);
    expect(result.ok).toBe(false);
    expect(result.toolName).toBe('get_world_domination');
    expect(result.data).toEqual({ error: 'Unknown tool: get_world_domination' });
  });

  it('returns ok=false when role cannot call the tool', async () => {
    registerTool(makeTool('get_human_activity'));
    const result = await dispatchToolCall('get_human_activity', {}, viewerCtx);
    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ error: 'Tool get_human_activity is not available for your role.' });
  });

  it('audits a denial', async () => {
    registerTool(makeTool('get_human_activity'));
    await dispatchToolCall('get_human_activity', { period: 'this_month' }, viewerCtx);
    expect(logAudit).toHaveBeenCalledWith(
      'insights.tool_call_denied',
      { tenantId: 'tenant-1', userId: 'account-2' },
      expect.objectContaining({ tool: 'get_human_activity', role: 'viewer' }),
    );
  });

  it('audits a successful invocation with input keys (not values)', async () => {
    registerTool(makeTool('get_agent_performance'));
    await dispatchToolCall('get_agent_performance', { time_range: { preset: 'this_week' } }, ownerCtx);
    expect(logAudit).toHaveBeenCalledWith(
      'insights.tool_call',
      { tenantId: 'tenant-1', userId: 'account-1' },
      expect.objectContaining({ tool: 'get_agent_performance', inputKeys: ['time_range'] }),
    );
  });

  it('returns ok=false when executor throws', async () => {
    registerTool({
      definition: {
        name: 'get_agent_performance',
        description: '',
        input_schema: { type: 'object', properties: {} },
      },
      execute: jest.fn().mockRejectedValue(new Error('database died')),
    });

    const result = await dispatchToolCall('get_agent_performance', {}, ownerCtx);
    expect(result.ok).toBe(false);
    expect(result.data).toEqual({ error: 'Tool execution failed: database died' });
  });

  it('wraps non-object executor returns under {result: ...}', async () => {
    registerTool({
      definition: {
        name: 'get_agent_performance',
        description: '',
        input_schema: { type: 'object', properties: {} },
      },
      execute: jest.fn().mockResolvedValue([1, 2, 3]),
    });

    const result = await dispatchToolCall('get_agent_performance', {}, ownerCtx);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ result: [1, 2, 3] });
  });
});
