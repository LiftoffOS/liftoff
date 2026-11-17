// Part 6 §D — OpenAI per-vendor mapper.

import { openaiRunItemToCanonical } from '../../per-vendor/openai';

describe('openaiRunItemToCanonical', () => {
  // Reasoning stays WITH its message under `message_scoped`. It used to
  // land in run-level `extras.responses_api_ids[]` / `extras.encrypted_reasoning[]`,
  // which `mergeProviderExtras` concatenates across the whole run — so nothing
  // downstream could tell which blob belonged to which message.
  it('keeps reasoning id + encrypted content message-scoped, not run-level', () => {
    const unknown = new Set<string>();
    const { message, extras } = openaiRunItemToCanonical({
      type: 'reasoning_item',
      rawItem: {
        id: 'resp-abc',
        rawContent: [{ text: 'first reasoning step' }, { text: 'second reasoning step' }],
        providerData: { encrypted_content: 'enc-blob-xyz' },
      },
    }, unknown);

    expect(message.role).toBe('assistant');
    expect(message.content[0]).toEqual({
      type: 'thinking',
      thinking: 'first reasoning step\nsecond reasoning step',
      signature: undefined,
    });
    expect(message.message_scoped).toEqual({
      responses_api_id: 'resp-abc',
      encrypted_reasoning: 'enc-blob-xyz',
    });
    expect(extras).toEqual({});
  });

  // A signed-but-empty reasoning block is load-bearing on same-engine replay.
  it('emits a thinking block when the text is empty but encrypted content is present', () => {
    const unknown = new Set<string>();
    const { message } = openaiRunItemToCanonical({
      type: 'reasoning_item',
      rawItem: { id: 'resp-empty', rawContent: [], providerData: { encrypted_content: 'enc-only' } },
    }, unknown);

    expect(message.content).toEqual([{ type: 'thinking', thinking: '', signature: undefined }]);
    expect(message.message_scoped).toEqual({ responses_api_id: 'resp-empty', encrypted_reasoning: 'enc-only' });
  });

  // A refusal is content, not an extra.
  it('maps message_output_item refusal to a first-class refusal block', () => {
    const unknown = new Set<string>();
    const { message, extras } = openaiRunItemToCanonical({
      type: 'message_output_item',
      rawItem: {
        content: [
          { type: 'output_text', text: 'here is the answer' },
          { type: 'refusal', refusal: 'cannot help with that' },
        ],
      },
    }, unknown);

    expect(message.content).toEqual([
      { type: 'text', text: 'here is the answer' },
      { type: 'refusal', text: 'cannot help with that' },
    ]);
    expect((extras as { refusals?: string[] }).refusals).toBeUndefined();
  });

  it('maps tool_call_item with stringified arguments → parsed input', () => {
    const unknown = new Set<string>();
    const { message } = openaiRunItemToCanonical({
      type: 'tool_call_item',
      rawItem: {
        type: 'function_call',
        name: 'lookup',
        arguments: '{"id":42,"verbose":true}',
        call_id: 'call_xyz',
      },
    }, unknown);

    expect(message.role).toBe('assistant');
    expect(message.content[0]).toEqual({
      type: 'tool_use',
      id: 'call_xyz',
      name: 'lookup',
      input: { id: 42, verbose: true },
    });
  });

  // A malformed call still HAPPENED. Dropping it orphaned the
  // tool_result that followed, which is exactly what makes a provider 400 on
  // replay. Emit the tool_use with the raw arguments preserved verbatim, and
  // count it on the REPLAY-RELEVANT set rather than the informational one.
  it('emits the tool_use with raw arguments when the arguments do not parse', () => {
    const unknown = new Set<string>();
    const replayRelevant = new Set<string>();
    const { message } = openaiRunItemToCanonical({
      type: 'tool_call_item',
      rawItem: { type: 'function_call', name: 'lookup', arguments: '{not json', call_id: 'call_xyz' },
    }, unknown, replayRelevant);

    expect(message.content).toEqual([{
      type: 'tool_use',
      id: 'call_xyz',
      name: 'lookup',
      input: { __raw_arguments: '{not json' },
    }]);
    expect(replayRelevant.has('openai:invalid_json_args')).toBe(true);
    expect(unknown.size).toBe(0);
  });

  it('maps tool_call_output_item to a user-role tool_result block', () => {
    const unknown = new Set<string>();
    const { message } = openaiRunItemToCanonical({
      type: 'tool_call_output_item',
      rawItem: { output: { ok: true, count: 3 }, call_id: 'call_xyz' },
    }, unknown);

    expect(message.role).toBe('user');
    expect(message.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_xyz',
      content: [{ type: 'text', text: JSON.stringify({ ok: true, count: 3 }) }],
    });
  });

  // The OpenAI SDK has no is_error on a function_call_result, so the
  // signal is read off `status`, `providerData.error`, and our own mcp-bridge
  // TOOL_ERROR envelope. Without it, a failed tool read as a successful one.
  it.each([
    ['SDK status', { call_id: 'c1', status: 'incomplete', output: 'boom' }],
    ['providerData.error', { call_id: 'c1', providerData: { error: 'nope' }, output: 'boom' }],
    ['bridge isError envelope', { call_id: 'c1', output: { isError: true, content: [{ type: 'text', text: 'boom' }] } }],
    ['bridge error envelope', { call_id: 'c1', output: { error: 'HITL gate denied' } }],
  ])('marks a failed tool_call_output_item is_error via %s', (_label, rawItem) => {
    const { message } = openaiRunItemToCanonical({ type: 'tool_call_output_item', rawItem }, new Set<string>());
    expect((message.content[0] as { is_error?: boolean }).is_error).toBe(true);
  });

  it('does not mark a successful tool_call_output_item is_error', () => {
    const { message } = openaiRunItemToCanonical({
      type: 'tool_call_output_item',
      rawItem: { call_id: 'c1', status: 'completed', output: 'fine' },
    }, new Set<string>());
    expect((message.content[0] as { is_error?: boolean }).is_error).toBeUndefined();
  });

  it('records unknown item types in the metric set', () => {
    const unknown = new Set<string>();
    const { message } = openaiRunItemToCanonical({ type: 'handoff_call_item', rawItem: {} }, unknown);
    expect(message.content).toEqual([]);
    expect(unknown.has('handoff_call_item')).toBe(true);
  });
});
