import { AgentRunStateService } from '../service';
import { AGENT_RUN_STATE_SCHEMA_VERSION } from '../types';
import type { AgentRunState, AgentRunItem, AgentRunItemInput } from '../types';

// Mock the database pool
const mockQuery = jest.fn();
jest.mock('../../../infrastructure/database', () => ({
  getPoolForService: jest.fn(() => ({ query: mockQuery })),
}));

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function makeState(overrides?: Partial<AgentRunState>): Omit<AgentRunState, '$schemaVersion' | 'createdAt' | 'updatedAt'> {
  return {
    invocationId: 'inv-001',
    agentId: 'agent-abc',
    tenantId: 'tenant-xyz',
    currentTurn: 0,
    status: 'running',
    items: [],
    providerState: { engineId: 'claude-agent-sdk' },
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    ...overrides,
  };
}

describe('AgentRunStateService', () => {
  let service: AgentRunStateService;

  beforeEach(() => {
    service = new AgentRunStateService();
    jest.clearAllMocks();
  });

  describe('create()', () => {
    it('inserts a new row and returns state with schema version', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.create(makeState());

      expect(result.$schemaVersion).toBe(AGENT_RUN_STATE_SCHEMA_VERSION);
      expect(result.invocationId).toBe('inv-001');
      expect(result.status).toBe('running');
      expect(result.items).toEqual([]);
      expect(typeof result.createdAt).toBe('string');
      expect(typeof result.updatedAt).toBe('string');
    });

    it('calls pool.query with INSERT ... ON CONFLICT DO UPDATE', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await service.create(makeState());

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO agent_run_states/i);
      expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/i);
      expect(params[0]).toBe('inv-001'); // invocation_id
      expect(params[1]).toBe('tenant-xyz'); // tenant_id
      expect(params[2]).toBe('agent-abc'); // agent_id
    });

    it('serializes items and usage into the state JSON blob', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const item: AgentRunItem = {
        type: 'message_output',
        role: 'assistant',
        content: 'Hello',
        turn: 1,
        timestamp: '2026-01-01T00:00:00Z',
      };
      await service.create(makeState({ items: [item], currentTurn: 1 }));

      const stateJson = JSON.parse(mockQuery.mock.calls[0][1][4] as string) as AgentRunState;
      expect(stateJson.items).toHaveLength(1);
      expect(stateJson.items[0].type).toBe('message_output');
      expect(stateJson.currentTurn).toBe(1);
    });
  });

  describe('load()', () => {
    it('returns null when no row found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await service.load('inv-missing');

      expect(result).toBeNull();
    });

    it('returns parsed AgentRunState when row exists', async () => {
      const storedState: AgentRunState = {
        ...makeState(),
        $schemaVersion: '1.2',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      mockQuery.mockResolvedValueOnce({ rows: [{ state: storedState }] });

      const result = await service.load('inv-001');

      expect(result).not.toBeNull();
      expect(result!.invocationId).toBe('inv-001');
      expect(result!.$schemaVersion).toBe('1.2');
    });

    it('queries by invocation_id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await service.load('inv-abc');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/WHERE invocation_id = \$1/i);
      expect(params[0]).toBe('inv-abc');
    });
  });

  describe('save()', () => {
    it('issues UPDATE with invocation_id as first param', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const state: AgentRunState = {
        ...makeState(),
        $schemaVersion: '1.0',
        status: 'complete',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };

      await service.save(state);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/UPDATE agent_run_states/i);
      expect(params[0]).toBe('inv-001');
      const savedState = JSON.parse(params[1] as string) as AgentRunState;
      expect(savedState.status).toBe('complete');
    });

    it('bumps updatedAt on save', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const oldUpdatedAt = '2025-01-01T00:00:00Z';
      const state: AgentRunState = {
        ...makeState(),
        $schemaVersion: '1.0',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: oldUpdatedAt,
      };

      await service.save(state);

      const savedState = JSON.parse(mockQuery.mock.calls[0][1][1] as string) as AgentRunState;
      expect(savedState.updatedAt).not.toBe(oldUpdatedAt);
    });
  });

  describe('appendItem()', () => {
    it('issues atomic jsonb append UPDATE', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const item: AgentRunItemInput = {
        type: 'tool_call',
        toolName: 'search_web',
        callId: 'c1',
        input: { query: 'test' },
        turn: 2,
        timestamp: '2026-01-01T00:00:00Z',
      };

      await service.appendItem('inv-001', item);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/jsonb_set/i);
      expect(params[0]).toBe('inv-001');
      const appended = JSON.parse(params[1] as string) as AgentRunItemInput;
      expect(appended.type).toBe('tool_call');
      expect((appended as Extract<AgentRunItem, { type: 'tool_call' }>).toolName).toBe('search_web');
    });

    // id and parentId are resolved by the STATEMENT, not by the caller. Doing it
    // in JS would mean reading the last item, then writing — and two concurrent
    // appends would both name the same predecessor as parent, forking a chain
    // that is supposed to be linear.
    it('mints the item id in the query parameters, not in the caller payload', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await service.appendItem('inv-001', {
        type: 'message_output', role: 'assistant', content: 'hi',
        turn: 1, timestamp: '2026-01-01T00:00:00Z',
      });
      const [, params] = mockQuery.mock.calls[0];
      const payload = JSON.parse(params[1] as string) as Record<string, unknown>;
      expect(payload.id).toBeUndefined();
      expect(payload.parentId).toBeUndefined();
      expect(typeof params[3]).toBe('string');
      expect(params[3]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('derives parentId from the last stored item inside the same statement', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await service.appendItem('inv-001', {
        type: 'message_output', role: 'assistant', content: 'hi',
        turn: 1, timestamp: '2026-01-01T00:00:00Z',
      });
      const [sql] = mockQuery.mock.calls[0];
      // The last element's id, which is SQL NULL on an empty array — exactly
      // what the first item of a run needs.
      expect(sql).toMatch(/state->'items'->-1->>'id'/);
      expect(sql).toMatch(/'parentId'/);
      expect(sql).toMatch(/'id'/);
    });
  });

  describe('setUpstreamSession()', () => {
    it('atomically merges upstreamSessionId onto providerState (preserving engineId)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await service.setUpstreamSession('inv-001', { sessionId: 'sess-abc' });
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/jsonb_set\(state, '\{providerState\}'/);
      expect(sql).toMatch(/providerState.*\|\|/); // concat merge, not overwrite
      expect(params[0]).toBe('inv-001');
      expect(JSON.parse(params[1] as string)).toEqual({ upstreamSessionId: 'sess-abc' });
    });

    it('records both session and thread ids when supplied', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await service.setUpstreamSession('inv-001', { sessionId: 's1', threadId: 't1' });
      expect(JSON.parse(mockQuery.mock.calls[0][1][1] as string)).toEqual({ upstreamSessionId: 's1', upstreamThreadId: 't1' });
    });

    it('is a no-op (issues no query) when the engine surfaced no id', async () => {
      await service.setUpstreamSession('inv-001', {});
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('fromJson()', () => {
    it('is a pure parse (the schema-version gate lives in load())', () => {
      const state: AgentRunState = {
        ...makeState(),
        $schemaVersion: '1.2',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      const result = service.fromJson(JSON.stringify(state));
      expect(result.invocationId).toBe('inv-001');
      expect(result.$schemaVersion).toBe('1.2');
    });
  });

  describe('toJson()', () => {
    it('serializes state to a valid JSON string', () => {
      const state: AgentRunState = {
        ...makeState(),
        $schemaVersion: '1.2',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };

      const json = service.toJson(state);
      const parsed = JSON.parse(json) as AgentRunState;
      expect(parsed.invocationId).toBe('inv-001');
      expect(parsed.$schemaVersion).toBe('1.2');
    });
  });

  // Legacy rows were upgraded in place by one-time data migrations
  // (325_agent_run_states_upgrade_to_1_1, then 359_agent_run_states_schema_1_2).
  // The read path supports the CURRENT version ONLY and fail-closes on any other
  // instead of silently coercing it: load() returns null (callers null-check →
  // resume falls back to the certified snapshot path).
  describe('schema-version gate (fail-closed, no coercion)', () => {
    it('load() returns the engine-aware 1.2 state (incl. upstream ids) unchanged', async () => {
      const modern: AgentRunState = {
        ...makeState({ providerState: { engineId: 'openai-codex', upstreamThreadId: 'thr_1' } }),
        $schemaVersion: '1.2', createdAt: 't', updatedAt: 't',
      };
      mockQuery.mockResolvedValueOnce({ rows: [{ state: modern }] });
      const loaded = await service.load('inv-001');
      expect(loaded!.providerState).toEqual({ engineId: 'openai-codex', upstreamThreadId: 'thr_1' });
    });

    it('load() fail-closes (→ null + warn) on a legacy 1.0 row, never coercing it', async () => {
      const { logger } = require('../../../infrastructure/logging');
      const legacyRow = { ...makeState(), $schemaVersion: '1.0', createdAt: 't', updatedAt: 't' };
      mockQuery.mockResolvedValueOnce({ rows: [{ state: legacyRow }] });
      expect(await service.load('inv-001')).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ schemaVersion: '1.0', event: 'run_state_unsupported_schema_version' }),
        expect.any(String),
      );
    });

    it('load() fail-closes (→ null + warn) on an unknown future version', async () => {
      const { logger } = require('../../../infrastructure/logging');
      const futureRow = { ...makeState(), $schemaVersion: '99.0', createdAt: 't', updatedAt: 't' };
      mockQuery.mockResolvedValueOnce({ rows: [{ state: futureRow }] });
      expect(await service.load('inv-001')).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ schemaVersion: '99.0', event: 'run_state_unsupported_schema_version' }),
        expect.any(String),
      );
    });
  });
});
