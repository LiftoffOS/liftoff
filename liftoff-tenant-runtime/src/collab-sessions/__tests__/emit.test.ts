import { messageFeatures, sinkKeyGuard, liveObjectKey } from '../emit';
import type { CanonicalTrajectory, CanonicalMessage } from '../../trajectories/types';

function traj(messages: CanonicalMessage[]): CanonicalTrajectory {
  return {
    schema_version: '1.0',
    trajectory_meta: {
      tenant_id: 't', agent_id: 'a', invocation_id: 'i',
      provider: 'anthropic', model: 'm', started_at: 'now',
      completed: true, tool_call_count: 0, outcome: 'success',
    },
    system: [], messages, tools: [],
  };
}

const text = (t: string) => ({ type: 'text' as const, text: t });
const toolResult = () => ({ type: 'tool_result' as const, tool_use_id: 'x', content: 'r' });
const toolUse = (name: string) => ({ type: 'tool_use' as const, id: 'u', name, input: {} });

describe('messageFeatures', () => {
  it('counts the prepended objective + real human turns, excluding tool-result user messages', () => {
    const f = messageFeatures(traj([
      { role: 'user', content: [text('objective')] },        // idx 0 — objective (human)
      { role: 'assistant', content: [toolUse('search')] },
      { role: 'user', content: [toolResult()] },             // tool result — NOT human
      { role: 'assistant', content: [text('answer'), toolUse('search')] },
      { role: 'user', content: [text('follow up')] },        // real human
    ]));
    expect(f.nUser).toBe(2);            // objective + follow-up
    expect(f.firstHumanIdx).toBe(0);
    expect(f.nAssistant).toBe(2);
    expect(f.nDistinctTools).toBe(1);   // 'search' once
  });

  it('spread is 0 for a single human message and a finite number for several', () => {
    const one = messageFeatures(traj([{ role: 'user', content: [text('o')] }]));
    expect(one.nUser).toBe(1);
    expect(one.spread).toBe(0);
    const many = messageFeatures(traj([
      { role: 'user', content: [text('o')] },
      { role: 'assistant', content: [text('a')] },
      { role: 'user', content: [text('b')] },
    ]));
    expect(many.spread).toBeGreaterThan(0);
  });
});

describe('sinkKeyGuard', () => {
  it('strips colons and dots from a timestamp', () => {
    expect(sinkKeyGuard('2026-07-23T00:00:00.000Z')).toBe('2026-07-23T00-00-00-000Z');
  });
});

describe('liveObjectKey', () => {
  it('gives two emits of the SAME session two different object keys', () => {
    // The sink writes create-only and treats the resulting 412 as success, so a
    // deterministic `live/<invocationId>` key silently discarded the second
    // write — which is every terminal emit after a human-paused resume.
    const first = liveObjectKey('inv-1', '2026-07-23T00:00:00.000Z');
    const second = liveObjectKey('inv-1', '2026-07-23T09:30:00.000Z');
    expect(first).not.toBe(second);
    expect(first).toBe('live/inv-1/2026-07-23T00-00-00-000Z');
  });

  it('is still stable for a retry of the same emit', () => {
    expect(liveObjectKey('inv-1', '2026-07-23T00:00:00.000Z'))
      .toBe(liveObjectKey('inv-1', '2026-07-23T00:00:00.000Z'));
  });

  it('stays under the live/ prefix the export reads', () => {
    expect(liveObjectKey('inv-1', '2026-07-23T00:00:00.000Z').startsWith('live/')).toBe(true);
  });
});
