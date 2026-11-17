const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => ({ query: mockQuery }) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as fs from 'fs';
import {
  autonomousSessionDir,
  isAutonomousResumeEnabled,
  loadRunSession,
  saveRunSession,
  ensureRunSessionDir,
  prepareAutonomousSession,
  rebuildFromCanonical,
} from '../autonomous-session';
import { sha256, canonicalSerialize } from '../session-artifact-envelope';

const AGENT = '22222222-2222-2222-2222-222222222222';

describe('autonomous-session (§4.10 Part C)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('isAutonomousResumeEnabled is gated on AUTONOMOUS_RESUME_ENABLED', () => {
    process.env.AUTONOMOUS_RESUME_ENABLED = '0';
    expect(isAutonomousResumeEnabled()).toBe(false);
    process.env.AUTONOMOUS_RESUME_ENABLED = '1';
    expect(isAutonomousResumeEnabled()).toBe(true);
  });

  it('autonomousSessionDir is deterministic + sanitized (no path/colon chars)', () => {
    const d = autonomousSessionDir('evt/abc:123');
    expect(d).toBe(autonomousSessionDir('evt/abc:123'));
    expect(d).toContain('tr-run-sessions');
    expect(d).toContain('evt-abc-123'); // sanitized leaf
    expect(d.split('/').pop()).not.toMatch(/[/:]/);
  });

  it('loadRunSession returns the row mapped (native artifact for the resume engine)', async () => {
    // Legacy row (no envelope columns) is owned by claude-agent-sdk; resuming under
    // claude-agent-sdk is a compatible native restore, so the row is returned.
    mockQuery.mockResolvedValueOnce({ rows: [{ sdk_session_id: 's1', jsonl_content: 'j' }] });
    expect(await loadRunSession('tk', '22222222-2222-2222-2222-222222222222', 'claude-agent-sdk'))
      .toEqual({ sdkSessionId: 's1', jsonlContent: 'j' });
  });

  it('loadRunSession returns undefined (fallback) when the artifact is owned by a different engine', async () => {
    // A claude-owned artifact must NOT be restored under a codex resume engine.
    mockQuery.mockResolvedValueOnce({ rows: [{ sdk_session_id: 's1', jsonl_content: 'j', execution_engine: 'claude-agent-sdk' }] });
    expect(await loadRunSession('tk', 'a', 'openai-codex')).toBeUndefined();
  });

  it('loadRunSession → undefined when no row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await loadRunSession('tk', 'a', 'claude-agent-sdk')).toBeUndefined();
  });

  it('loadRunSession is fail-open (→ undefined on DB error)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db'));
    expect(await loadRunSession('tk', 'a', 'claude-agent-sdk')).toBeUndefined();
  });

  it('saveRunSession upserts by (trigger_key, agent_id)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await saveRunSession('tk', AGENT, 's', 'j');
    expect(mockQuery.mock.calls[0][0]).toMatch(/ON CONFLICT \(trigger_key, agent_id\) DO UPDATE/);
  });

  it('ensureRunSessionDir mkdir -p the cwd (idempotent)', async () => {
    const dir = autonomousSessionDir('ensure-' + Date.now());
    await fs.promises.rm(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);
    await ensureRunSessionDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    await ensureRunSessionDir(dir); // idempotent, no throw
    expect(fs.existsSync(dir)).toBe(true);
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  // Regression guard for the "Claude Code executable not found" bug: the error is a
  // MISSING CWD, not a missing binary. A FIRST autonomous run (no prior session) must
  // still get its sessionStateDir created on disk — before the fix, sessionStateDir
  // was set without the dir, so the SDK's spawn(cwd) ENOENT'd and EVERY first-run
  // autonomous Anthropic execution failed (dev AND prod).
  it('prepareAutonomousSession creates the cwd even with NO prior session', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // loadRunSession → no prior
    const key = 'noprior-' + Date.now();
    const expectedDir = autonomousSessionDir(key);
    await fs.promises.rm(expectedDir, { recursive: true, force: true });

    const res = await prepareAutonomousSession(key, AGENT, 'claude-agent-sdk');

    expect(res.sessionStateDir).toBe(expectedDir);
    expect(res.resumeSessionId).toBeUndefined();
    expect(fs.existsSync(expectedDir)).toBe(true); // THE FIX — cwd must exist
    await fs.promises.rm(expectedDir, { recursive: true, force: true });
  });

  it('prepareAutonomousSession returns resumeSessionId + creates the cwd when a prior exists', async () => {
    const origHome = process.env.HOME;
    const tmpHome = autonomousSessionDir('home-' + Date.now()); // isolate the SDK transcript dir
    process.env.HOME = tmpHome;
    try {
      mockQuery.mockResolvedValueOnce({ rows: [{ sdk_session_id: 'sess-9', jsonl_content: '{"x":1}' }] });
      const key = 'prior-' + Date.now();
      const res = await prepareAutonomousSession(key, AGENT, 'claude-agent-sdk');
      expect(res.resumeSessionId).toBe('sess-9');
      expect(fs.existsSync(res.sessionStateDir)).toBe(true);
      await fs.promises.rm(res.sessionStateDir, { recursive: true, force: true });
    } finally {
      process.env.HOME = origHome;
      await fs.promises.rm(tmpHome, { recursive: true, force: true });
    }
  });
});

// The cross-engine rebuild off the session tables bounds each tool result to
// the cap the model-facing result gets, the way the pause checkpoint's replay
// does: a rebuilt conversation never carries more than the model was shown.
describe('rebuildFromCanonical bounds tool results', () => {
  it('a result past the cap is truncated in the rebuilt messages', async () => {
    const prev = process.env.TOOL_RESULT_MAX_CHARS;
    process.env.TOOL_RESULT_MAX_CHARS = '200';
    try {
      const messages = [
        { role: 'user', content: [{ type: 'text', text: 'read the file' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(5000) }] },
      ];
      mockQuery.mockResolvedValueOnce({
        rows: [{
          canonical_content: JSON.parse(JSON.stringify(messages)),
          canonical_schema_version: '1.1',
          canonical_sha256: sha256(canonicalSerialize(messages)),
          execution_engine: 'openai-agents',
        }],
      });
      const rebuilt = await rebuildFromCanonical({ kind: 'autonomous', triggerKey: 'trig' }, AGENT, 'claude-agent-sdk');
      expect(rebuilt).toBeDefined();
      const result = rebuilt!.flatMap((m) => m.content).find((c) => c.type === 'tool_result') as { result: unknown };
      expect(String(result.result).length).toBeLessThan(400);
      expect(String(result.result)).toContain('truncated');
    } finally {
      if (prev === undefined) delete process.env.TOOL_RESULT_MAX_CHARS; else process.env.TOOL_RESULT_MAX_CHARS = prev;
    }
  });
});
