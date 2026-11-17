import { redactTrajectoryContent } from '../sink';
import type { CanonicalTrajectory } from '../types';

function mkTrajectory(): CanonicalTrajectory {
  return {
    schema_version: '1.0',
    trajectory_meta: {
      tenant_id: 't1', agent_id: 'a1', invocation_id: 'i1',
      provider: 'anthropic', model: 'm', started_at: '2026-06-28T00:00:00.000Z',
      completed: true, tool_call_count: 1, outcome: 'success',
    },
    system: [{ type: 'text', text: 'Contact admin at admin@acme.com' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'My SSN is 123-45-6789 and card 4111 1111 1111 1111' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'The user email is jane.doe@example.com' },
        { type: 'redacted_thinking', data: 'ENCRYPTED_OPAQUE_BLOB' },
        { type: 'tool_use', id: 'u1', name: 'send', input: { to: 'bob@corp.io', key: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX', phone: '(415) 555-1234' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'u1', content: 'Sent to customer 987-65-4321' },
        { type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'Reply from alice@x.com' }] },
      ] },
    ],
    tools: [],
  };
}

describe('sink redactTrajectoryContent', () => {
  it('redacts PII + credentials across text, thinking, tool input, tool results, and system', () => {
    const json = JSON.stringify(redactTrajectoryContent(mkTrajectory()));
    for (const raw of [
      'admin@acme.com', '123-45-6789', '4111 1111 1111 1111', 'jane.doe@example.com',
      'bob@corp.io', 'sk-ABCDEFGHIJKLMNOPQRSTUVWX', '(415) 555-1234', '987-65-4321', 'alice@x.com',
    ]) {
      expect(json).not.toContain(raw);
    }
    expect(json).toContain('[REDACTED:email]');
    expect(json).toContain('[REDACTED:ssn]');
    expect(json).toContain('[REDACTED:credit_card]');
    expect(json).toContain('[REDACTED:openai_api_key]');
  });

  it('preserves block structure, ids, and provider-encrypted redacted_thinking', () => {
    const out = redactTrajectoryContent(mkTrajectory());
    const assistant = out.messages[1].content;
    expect(assistant[0].type).toBe('thinking');
    expect(assistant[2].type).toBe('tool_use');
    expect((assistant[2] as { id: string }).id).toBe('u1');
    expect((assistant[2] as { name: string }).name).toBe('send');
    expect((assistant[1] as { data: string }).data).toBe('ENCRYPTED_OPAQUE_BLOB');
    expect(out.messages).toHaveLength(3);
    expect((out.messages[2].content[0] as { tool_use_id: string }).tool_use_id).toBe('u1');
  });
});
