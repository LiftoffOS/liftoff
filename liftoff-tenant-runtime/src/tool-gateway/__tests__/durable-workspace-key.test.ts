// Which runs keep their workspace between ticks, and which must not.
//
// A scheduled agent has no thread, so sandboxSessionIdFor falls through to the
// invocation and every tick gets a fresh workspace. Provisioning takes about a
// minute, so a five-minute cron pays that minute ~288 times a day and starts
// each run on an empty disk — re-cloning the repository it cloned five minutes
// ago. Worse for self-continuation: a run that schedules a follow-up to finish
// its work resumes with none of that work on disk.
//
// The narrowness is the whole design. A shared workspace is a weaker isolation
// boundary than a fresh one, so only the runs that actually repeat get it.
import { durableWorkspaceKeyFor, sandboxSessionIdFor } from '../service';

const AGENT = '22222222-2222-2222-2222-222222222222';

describe('durableWorkspaceKeyFor', () => {
  it('gives a scheduled run a key that survives the tick', () => {
    expect(durableWorkspaceKeyFor({ agentId: AGENT })).toBe(`agent:${AGENT}`);
  });

  it('gives two ticks of the same agent the SAME key', () => {
    // The point of the change: same agent, different invocations, one workspace.
    const first = durableWorkspaceKeyFor({ agentId: AGENT });
    const second = durableWorkspaceKeyFor({ agentId: AGENT });
    expect(first).toBe(second);
  });

  it('leaves a threaded run on the thread workspace', () => {
    // Chat already scopes a workspace across the turns of one conversation.
    // Overriding that would move a conversation's files under the agent, where a
    // different conversation with the same agent would see them.
    expect(durableWorkspaceKeyFor({ agentId: AGENT, threadId: 'thread-1' })).toBeUndefined();
  });

  it('leaves a delegated child on its own per-invocation workspace', () => {
    // Isolation is the point for children: they are ephemeral, siblings may run
    // concurrently, and none of them should see another's files.
    expect(durableWorkspaceKeyFor({ agentId: AGENT, delegationDepth: 1 })).toBeUndefined();
    expect(durableWorkspaceKeyFor({ agentId: AGENT, delegationDepth: 2 })).toBeUndefined();
  });

  it('treats depth 0 and null as top-level', () => {
    expect(durableWorkspaceKeyFor({ agentId: AGENT, delegationDepth: 0 })).toBe(`agent:${AGENT}`);
    expect(durableWorkspaceKeyFor({ agentId: AGENT, delegationDepth: null })).toBe(`agent:${AGENT}`);
  });

  it('declines rather than inventing a key when there is no agent', () => {
    expect(durableWorkspaceKeyFor({})).toBeUndefined();
  });

  it('is accepted by sandboxSessionIdFor as the highest-precedence handle', () => {
    // The key rides the EXISTING extension point (precedence 1), so the
    // fallback chain that serves delegated children and wake polls is untouched.
    const key = durableWorkspaceKeyFor({ agentId: AGENT })!;
    expect(sandboxSessionIdFor({ workspaceSessionId: key, invocationId: 'inv-1' })).toBe(key);
    // And without it, the old behaviour is exactly as before.
    expect(sandboxSessionIdFor({ invocationId: 'inv-1' })).toBe('inv-1');
  });
});
