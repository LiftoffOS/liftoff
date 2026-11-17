// The canary's job is to notice a record production should not have written.
// These tests feed it the two real defect shapes and assert it says so.

const query = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query }),
}));

// The adapter index pulls every vendor SDK; the acceptance check itself is
// certified for real in certification.test.ts against the vendor's own schema.
// Here it is stubbed so these tests exercise the CANARY's logic.
const assertCanReplayHistory = jest.fn();
jest.mock('../../agent-execution/adapter', () => ({
  constructAdapterForEngine: () => ({ assertCanReplayHistory }),
}));

import { runCanonicalRebuildCanary } from '../canonical-rebuild-canary';
import type { CanonicalMessage } from '../../trajectories/types';

/** A whole conversation: questions as well as answers. */
const WHOLE: CanonicalMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Remember the codeword ZEPHYRA.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Got it, ZEPHYRA.' }] },
  { role: 'user', content: [{ type: 'text', text: 'What was the codeword?' }] },
];

/** What a writer that records only adapter output produces: the agent's own
 *  answers, and none of the prompts. */
const HALF: CanonicalMessage[] = [
  { role: 'assistant', content: [{ type: 'text', text: 'ZEPHYRA' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ZEPHYRB' }] },
];

function armRows(chat: unknown[], autonomous: unknown[] = []): void {
  query.mockReset();
  query
    .mockResolvedValueOnce({ rows: chat })
    .mockResolvedValueOnce({ rows: autonomous });
}

function chatRow(messages: CanonicalMessage[], engine = 'claude-agent-sdk') {
  return {
    thread_id: 'thread-1',
    agent_id: 'agent-1',
    execution_engine: engine,
    canonical_content: messages,
  };
}

describe('canonical rebuild canary', () => {
  it('passes a whole conversation, and rebuilds it for the other engines', async () => {
    armRows([chatRow(WHOLE)]);
    const result = await runCanonicalRebuildCanary();

    expect(result.sampled).toBe(1);
    expect(result.halfConversations).toBe(0);
    expect(result.findings).toEqual([]);
    // It actually tried: a canary that silently rebuilds nothing looks
    // identical to one where everything is fine.
    expect(result.rebuildsAttempted).toBeGreaterThan(0);
  });

  it('flags a record with no user turn as a half conversation', async () => {
    armRows([chatRow(HALF)]);
    const result = await runCanonicalRebuildCanary();

    expect(result.halfConversations).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].problem).toMatch(/NO user turn/);
  });

  it('does not waste rebuilds on a record already known to be useless', async () => {
    armRows([chatRow(HALF)]);
    const result = await runCanonicalRebuildCanary();
    // Every downstream check would PASS on it — that is the shape of the
    // defect, and why rebuilding it would be misleading rather than merely
    // wasteful.
    expect(result.rebuildsAttempted).toBe(0);
  });

  it('reads both stores, not just chat', async () => {
    armRows(
      [chatRow(WHOLE)],
      [{
        trigger_key: 'trigger-1',
        agent_id: 'agent-2',
        execution_engine: 'openai-agents',
        canonical_content: WHOLE,
      }],
    );
    const result = await runCanonicalRebuildCanary();
    expect(result.sampled).toBe(2);
  });

  it('ignores a row whose canonical content is not an array', async () => {
    armRows([chatRow({ messages: WHOLE } as unknown as CanonicalMessage[])]);
    const result = await runCanonicalRebuildCanary();

    // A shape it cannot read is not a defect it should report against that ROW —
    // the loader is what would have rejected it, and this job does not duplicate
    // that judgment.
    expect(result.sampled).toBe(0);
    expect(result.findings.some((f) => f.key === 'thread-1')).toBe(false);
    // But the RUN still checked nothing, and that is reported. The two are
    // different statements and the row being unreadable does not excuse the run
    // from saying it covered no records.
    expect(result.findings.map((f) => f.problem)).toEqual([
      expect.stringMatching(/no canonical record exists/),
    ]);
  });

  it('does not call an empty sample healthy', async () => {
    // A live run can scan hundreds of sessions, find not one canonical record,
    // report zero findings, and have the aggregate line say healthy. A canary that
    // checked nothing has established nothing, and reporting otherwise
    // reproduces the defect it was built to catch.
    armRows([], []);
    const result = await runCanonicalRebuildCanary();

    expect(result.sampled).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].problem).toMatch(/no canonical record exists/);
  });

  it('reports healthy=false only when there is something to act on', async () => {
    armRows([chatRow(WHOLE)]);
    expect((await runCanonicalRebuildCanary()).findings).toHaveLength(0);
    armRows([chatRow(HALF)]);
    expect((await runCanonicalRebuildCanary()).findings.length).toBeGreaterThan(0);
  });
});
