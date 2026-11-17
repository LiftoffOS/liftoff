// Part 6 §F — buildCanonical assembles CanonicalTrajectory from the buffer.

import { makeRecorder, releaseBuffer } from '../recorder';
import { buildCanonical } from '../canonical-builder';

function seedBuffer(invocationId: string): void {
  const rec = makeRecorder(invocationId);
  rec.recordRaw({
    invocationId, provider: 'anthropic', model: 'claude-opus-4-8',
    rawKind: 'anthropic_sdk_message',
    raw: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
      { type: 'tool_use', id: 'tu1', name: 'lookup', input: {} },
    ] },
  });
  rec.recordRaw({
    invocationId, provider: 'anthropic', model: 'claude-opus-4-8',
    rawKind: 'anthropic_sdk_message',
    raw: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false },
    ] },
  });
  rec.recordRaw({
    invocationId, provider: 'anthropic', model: 'claude-opus-4-8',
    rawKind: 'anthropic_sdk_message',
    raw: { role: 'assistant', content: [
      { type: 'text', text: 'the answer is 42' },
    ] },
  });
}

describe('buildCanonical', () => {
  it('prepends the initial user objective as the first message', () => {
    const invocationId = `inv-${Math.random()}`;
    seedBuffer(invocationId);

    const traj = buildCanonical({
      invocationId,
      systemPrompt: 'system prompt',
      objective: 'find the answer',
      toolDefs: [{ name: 'lookup', description: 'd', input_schema: { type: 'object' } }],
      meta: {
        tenantId: '11111111-1111-1111-1111-111111111111',
        agentId: '22222222-2222-2222-2222-222222222222',
        completed: true,
        outcome: 'success',
      },
    });

    expect(traj).not.toBeNull();
    expect(traj!.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'find the answer' }],
    });
    releaseBuffer(invocationId);
  });

  it('counts tool_use blocks correctly', () => {
    const invocationId = `inv-${Math.random()}`;
    seedBuffer(invocationId);
    const traj = buildCanonical({
      invocationId, systemPrompt: 'sp', objective: 'obj', toolDefs: [],
      meta: { tenantId: 't', agentId: 'a', completed: true, outcome: 'success' },
    });
    expect(traj!.trajectory_meta.tool_call_count).toBe(1);
    releaseBuffer(invocationId);
  });

  it('returns null when the buffer has no messages', () => {
    const traj = buildCanonical({
      invocationId: `nonexistent-${Math.random()}`,
      systemPrompt: '', objective: 'obj', toolDefs: [],
      meta: { tenantId: 't', agentId: 'a', completed: true, outcome: 'success' },
    });
    expect(traj).toBeNull();
  });

  it('omits parent_invocation_id when not supplied', () => {
    const invocationId = `inv-${Math.random()}`;
    seedBuffer(invocationId);
    const traj = buildCanonical({
      invocationId, systemPrompt: 'sp', objective: 'obj', toolDefs: [],
      meta: { tenantId: 't', agentId: 'a', completed: true, outcome: 'success' },
    });
    expect(traj!.trajectory_meta.parent_invocation_id).toBeUndefined();
    releaseBuffer(invocationId);
  });

  it('includes parent_invocation_id when supplied (delegated child)', () => {
    const invocationId = `inv-${Math.random()}`;
    seedBuffer(invocationId);
    const traj = buildCanonical({
      invocationId, systemPrompt: 'sp', objective: 'obj', toolDefs: [],
      meta: { tenantId: 't', agentId: 'a', completed: true, outcome: 'success', parentInvocationId: 'parent-1' },
    });
    expect(traj!.trajectory_meta.parent_invocation_id).toBe('parent-1');
    releaseBuffer(invocationId);
  });
});
