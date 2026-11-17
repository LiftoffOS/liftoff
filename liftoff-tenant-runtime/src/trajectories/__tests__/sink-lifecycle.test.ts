// Trajectory sink behavior, parametrized over the concrete engine.
// Proves: canonical content is written to GCS under the new schema version; the
// index row identifies provider, model AND engine; and a quality-filter SKIP
// (no reasoning blocks) still writes an index row (accounting) carrying the
// engine. Repository + GCS are mocked so no DB/network is touched.

jest.mock('../repository', () => ({ insertTrajectoryIndex: jest.fn().mockResolvedValue(undefined) }));

import { TrajectorySink } from '../sink';
import { insertTrajectoryIndex } from '../repository';
import type { CanonicalTrajectory } from '../types';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../../agent-execution/adapter/types';
import type { ExecutionEngineId } from '../../agent-execution/adapter/types';

const mockSave = jest.fn().mockResolvedValue(undefined);
const storage = {
  bucket: () => ({ file: () => ({ save: mockSave }) }),
} as unknown as import('@google-cloud/storage').Storage;

function traj(engine: ExecutionEngineId, opts: { withReasoning: boolean }): CanonicalTrajectory {
  return {
    schema_version: '1.1',
    trajectory_meta: {
      tenant_id: '11111111-1111-1111-1111-111111111111',
      agent_id: '22222222-2222-2222-2222-222222222222',
      invocation_id: '33333333-3333-3333-3333-333333333333',
      provider: engine === 'google-adk' ? 'google' : engine === 'opencode' ? 'openrouter' : 'openai',
      execution_engine: engine,
      model: 'test-model',
      started_at: '2026-01-01T00:00:00.000Z',
      completed: true,
      tool_call_count: 0,
      outcome: 'success',
    },
    system: [],
    messages: [{
      role: 'assistant',
      content: opts.withReasoning
        ? [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'hi' }]
        : [{ type: 'text', text: 'hi' }],
    }],
    tools: [],
  };
}

// Every engine, not a sample of three. The sink writes the index row that says
// which engine produced a record, and a record whose engine is wrong is a record
// no rebuild can repair for the right one.
const ENGINES: readonly ExecutionEngineId[] = RESOLVABLE_EXECUTION_ENGINE_IDS;

describe('TrajectorySink — index row + schema per engine', () => {
  beforeEach(() => { mockSave.mockClear(); (insertTrajectoryIndex as jest.Mock).mockClear(); });

  it.each(ENGINES)('writes GCS (schema 1.1) and an index row identifying engine %s', async (engine) => {
    const sink = new TrajectorySink('bucket', storage);
    const res = await sink.write(traj(engine, { withReasoning: true }));
    expect(res.written).toBe(true);
    expect(mockSave).toHaveBeenCalledTimes(1);
    const row = (insertTrajectoryIndex as jest.Mock).mock.calls[0][0];
    expect(row.provider).toBe(engine === 'google-adk' ? 'google' : engine === 'opencode' ? 'openrouter' : 'openai');
    expect(row.model).toBe('test-model');
    expect(row.executionEngine).toBe(engine);
    expect(row.schemaVersion).toBe('1.1');
    expect(row.gcsPath).toContain('gs://bucket/');
  });

  it.each(ENGINES)('quality-filter SKIP (no reasoning) still writes an index row carrying engine %s', async (engine) => {
    const sink = new TrajectorySink('bucket', storage);
    const res = await sink.write(traj(engine, { withReasoning: false }));
    expect(res.written).toBe(false); // GCS skipped (no reasoning)
    expect(mockSave).not.toHaveBeenCalled();
    const row = (insertTrajectoryIndex as jest.Mock).mock.calls[0][0];
    expect(row.gcsPath).toBeNull(); // accounted-for-but-not-written
    expect(row.executionEngine).toBe(engine);
    expect(row.schemaVersion).toBe('1.1');
  });

  it('records nested_engine on a code_session index row without an outer execution_engine', async () => {
    const t = traj('openai-codex', { withReasoning: true });
    delete t.trajectory_meta.execution_engine;
    t.trajectory_meta.nested_kind = 'code_session';
    t.trajectory_meta.nested_engine = 'codex-code-session';
    const sink = new TrajectorySink('bucket', storage);
    await sink.write(t);
    const row = (insertTrajectoryIndex as jest.Mock).mock.calls[0][0];
    expect(row.nestedEngine).toBe('codex-code-session');
    expect(row.executionEngine).toBeNull();
    expect(row.nestedKind).toBe('code_session');
  });
});
