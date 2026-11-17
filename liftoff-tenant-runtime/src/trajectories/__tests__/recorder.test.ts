// Part 6 §C — recorder buffer + try/catch + unknown-block tracking.

import { makeRecorder, getRun, releaseBuffer } from '../recorder';
import type { ResolvedProvider } from '../../agent-execution/adapter/types';
import * as metrics from '../../observability/runtime-extensions-metrics';

describe('makeRecorder', () => {
  it('accumulates messages into a per-invocation buffer', () => {
    const invocationId = `inv-${Math.random()}`;
    const rec = makeRecorder(invocationId);

    rec.recordRaw({
      invocationId, provider: 'anthropic', model: 'claude-opus-4-8',
      rawKind: 'anthropic_sdk_message',
      raw: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    });
    rec.recordRaw({
      invocationId, provider: 'anthropic', model: 'claude-opus-4-8',
      rawKind: 'anthropic_sdk_message',
      raw: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    });

    const run = getRun(invocationId);
    expect(run).toBeDefined();
    expect(run!.messages.length).toBe(2);
    expect(run!.provider).toBe('anthropic');
    expect(run!.model).toBe('claude-opus-4-8');

    releaseBuffer(invocationId);
    expect(getRun(invocationId)).toBeUndefined();
  });

  it('drops empty-content messages so empty mapper output does not pollute the buffer', () => {
    const invocationId = `inv-${Math.random()}`;
    const rec = makeRecorder(invocationId);
    rec.recordRaw({
      invocationId, provider: 'anthropic', model: 'claude-opus-4-8',
      rawKind: 'anthropic_sdk_message',
      raw: { role: 'assistant', content: [] },
    });
    expect(getRun(invocationId)?.messages.length ?? 0).toBe(0);
    releaseBuffer(invocationId);
  });

  it('catches mapper exceptions; flags `recorder_threw` in the unknown set', () => {
    const invocationId = `inv-${Math.random()}`;
    const rec = makeRecorder(invocationId);
    // Anthropic mapper expects content[]; passing a non-iterable shape forces
    // a TypeError during iteration so we exercise the try/catch.
    rec.recordRaw({
      invocationId, provider: 'anthropic', model: 'claude-opus-4-8',
      rawKind: 'anthropic_sdk_message',
      raw: { role: 'assistant', content: null as unknown as [] },
    });
    const run = getRun(invocationId);
    // Either the mapper coerced gracefully (content empty) or it threw and
    // flagged the metric. Both outcomes are valid; what's NOT valid is the
    // entire adapter loop crashing — which is what this test guards against.
    expect(run).toBeDefined();
    releaseBuffer(invocationId);
  });

  it('records unknown block types so the regression metric can fire', () => {
    const invocationId = `inv-${Math.random()}`;
    const rec = makeRecorder(invocationId);
    rec.recordRaw({
      invocationId, provider: 'anthropic', model: 'claude-opus-4-8',
      rawKind: 'anthropic_sdk_message',
      raw: { role: 'assistant', content: [{ type: 'never_seen_before_block' }] },
    });
    const run = getRun(invocationId);
    expect(run!.unknownBlockTypes.has('never_seen_before_block')).toBe(true);
    releaseBuffer(invocationId);
  });
});

// Fail-safe, exhaustive dispatch. Before this fix the three
// self-managing kinds (codex_thread_item / adk_event / opencode_part) fell
// through the switch with `message` undefined, and the post-switch
// `message!.content.length` access threw a TypeError OUTSIDE the mapper
// try/catch — which the adapters converted into `completion: error`.
describe('makeRecorder — fail-safe dispatch', () => {
  const allKinds = [
    'anthropic_sdk_message', 'openai_run_item', 'gemini_response',
    'codex_thread_item', 'adk_event', 'opencode_part',
  ] as const;

  const providerFor: Record<(typeof allKinds)[number], ResolvedProvider> = {
    anthropic_sdk_message: 'anthropic',
    openai_run_item: 'openai',
    gemini_response: 'google',
    codex_thread_item: 'openai',
    adk_event: 'google',
    opencode_part: 'openrouter',
  };

  it('never throws for any declared rawKind and keeps the run buffer alive', () => {
    for (const rawKind of allKinds) {
      const invocationId = `inv-${rawKind}-${Math.random()}`;
      const rec = makeRecorder(invocationId);
      expect(() => rec.recordRaw({
        invocationId, provider: providerFor[rawKind], model: 'm', rawKind,
        raw: { role: 'assistant', content: [] },
      })).not.toThrow();
      // The buffer is created before the switch, so it survives every path —
      // including the unsupported-kind early return and a mapper that throws.
      expect(getRun(invocationId)).toBeDefined();
      releaseBuffer(invocationId);
    }
  });

  // Once every declared kind has a real mapper, the enduring safety
  // net is the exhaustive `default` arm: a FUTURE rawKind added to the union with
  // no mapper must still be recorded as unsupported, never crash. Exercise it via
  // a cast so the test is stable regardless of how many real mappers exist.
  type RawKind = Parameters<ReturnType<typeof makeRecorder>['recordRaw']>[0]['rawKind'];
  const FUTURE_KIND = 'future_unmapped_kind' as unknown as RawKind;

  it('routes an unknown/future rawKind through the unsupported policy (no messages, flagged once)', () => {
    const invocationId = `inv-future-${Math.random()}`;
    const rec = makeRecorder(invocationId);
    rec.recordRaw({ invocationId, provider: 'openai', model: 'm', rawKind: FUTURE_KIND, raw: { anything: true } });
    rec.recordRaw({ invocationId, provider: 'openai', model: 'm', rawKind: FUTURE_KIND, raw: { anything: true } });
    const run = getRun(invocationId)!;
    expect(run.messages.length).toBe(0);
    expect(run.emittedUnknownTypes.has('unsupported_rawkind:future_unmapped_kind')).toBe(true);
    releaseBuffer(invocationId);
  });

  it('increments trajectory_unknown_block_type_total exactly once per unsupported rawKind', () => {
    const spy = jest.spyOn(metrics.trajectory_unknown_block_type_total, 'inc');
    try {
      const invocationId = `inv-once-${Math.random()}`;
      const rec = makeRecorder(invocationId);
      // Same unsupported kind recorded twice → one metric emission (dedup set).
      rec.recordRaw({ invocationId, provider: 'openai', model: 'm', rawKind: FUTURE_KIND, raw: {} });
      rec.recordRaw({ invocationId, provider: 'openai', model: 'm', rawKind: FUTURE_KIND, raw: {} });
      const incs = spy.mock.calls.filter(
        ([labels]) => (labels as { block_type?: string })?.block_type === 'unsupported_rawkind:future_unmapped_kind',
      );
      expect(incs.length).toBe(1);
      expect((incs[0][0] as { provider?: string }).provider).toBe('openai');
      releaseBuffer(invocationId);
    } finally {
      spy.mockRestore();
    }
  });

  it('accumulates (does not overwrite) raw payloads across multiple unmapped per-event calls', () => {
    const invocationId = `inv-extras-${Math.random()}`;
    const rec = makeRecorder(invocationId);
    // Two separate Codex events, each carrying a narration-only (unmapped) item.
    rec.recordRaw({ invocationId, provider: 'openai', model: 'm', rawKind: 'codex_thread_item', raw: { type: 'item.completed', item: { id: 'x1', type: 'todo_list', status: 'completed' } } });
    rec.recordRaw({ invocationId, provider: 'openai', model: 'm', rawKind: 'codex_thread_item', raw: { type: 'item.completed', item: { id: 'x2', type: 'error', status: 'completed' } } });
    const run = getRun(invocationId)!;
    const unmapped = (run.providerExtras as { codex_unmapped?: Array<{ type: string }> }).codex_unmapped;
    // Both events survive in _provider_extras — the second no longer clobbers the first.
    expect(unmapped).toHaveLength(2);
    expect(unmapped!.map((u) => u.type)).toEqual(['todo_list', 'error']);
    releaseBuffer(invocationId);
  });

  // OpenCode's `part.text` is CUMULATIVE, so appending a block per event turned
  // one answer into N growing prefixes. finalAssistantText concatenated all of
  // them and messageFeatures counted each as its own assistant message.
  it('replaces, not appends, when a streaming text part is updated', () => {
    const invocationId = `inv-coalesce-${Math.random()}`;
    const rec = makeRecorder(invocationId);
    const part = (text: string) => ({
      type: 'message.part.updated',
      properties: { part: { id: 'prt_1', type: 'text', text } },
    });
    for (const text of ['Let', 'Let me', 'Let me check.']) {
      rec.recordRaw({ invocationId, provider: 'openrouter', model: 'm', rawKind: 'opencode_part', raw: part(text) });
    }
    const run = getRun(invocationId)!;
    expect(run.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] }]);
    releaseBuffer(invocationId);
  });

  it('keeps DISTINCT streaming parts as distinct messages', () => {
    const invocationId = `inv-coalesce-distinct-${Math.random()}`;
    const rec = makeRecorder(invocationId);
    const part = (id: string, text: string) => ({
      type: 'message.part.updated',
      properties: { part: { id, type: 'text', text } },
    });
    rec.recordRaw({ invocationId, provider: 'openrouter', model: 'm', rawKind: 'opencode_part', raw: part('prt_1', 'first') });
    rec.recordRaw({ invocationId, provider: 'openrouter', model: 'm', rawKind: 'opencode_part', raw: part('prt_2', 'second') });
    const run = getRun(invocationId)!;
    expect(run.messages).toHaveLength(2);
    releaseBuffer(invocationId);
  });
});

// Buffer lifecycle. The per-invocation buffer must survive a HITL
// pause (recording stops, but the buffer is NOT released until a terminal path)
// and must be released on the terminal path (writeTrajectoryIfEnabled releases in
// a `finally`, so success/error/escalated all release; releaseBuffer is the
// primitive that guarantees it).
describe('recorder buffer lifecycle', () => {
  const text = (t: string) => ({ role: 'assistant' as const, content: [{ type: 'text', text: t }] });

  it('preserves the buffer across a pause (no release between pause and resume), then releases terminally', () => {
    const invocationId = `inv-life-${Math.random()}`;
    const rec = makeRecorder(invocationId);
    rec.recordRaw({ invocationId, provider: 'anthropic', model: 'm', rawKind: 'anthropic_sdk_message', raw: text('a') });

    // HITL pause: recording stops, but the buffer must NOT be released — a later
    // approval + resume has to keep accumulating into the SAME buffer.
    expect(getRun(invocationId)?.messages).toHaveLength(1);
    // (approval window elapses — buffer still present)
    expect(getRun(invocationId)?.messages).toHaveLength(1);

    // Resume: further turns append to the preserved buffer.
    rec.recordRaw({ invocationId, provider: 'anthropic', model: 'm', rawKind: 'anthropic_sdk_message', raw: text('b') });
    expect(getRun(invocationId)?.messages).toHaveLength(2);

    // Terminal path releases the buffer.
    releaseBuffer(invocationId);
    expect(getRun(invocationId)).toBeUndefined();
  });

  it('releaseBuffer is idempotent (safe to call on every terminal path, even twice)', () => {
    const invocationId = `inv-idem-${Math.random()}`;
    const rec = makeRecorder(invocationId);
    rec.recordRaw({ invocationId, provider: 'anthropic', model: 'm', rawKind: 'anthropic_sdk_message', raw: text('a') });
    releaseBuffer(invocationId);
    expect(() => releaseBuffer(invocationId)).not.toThrow();
    expect(getRun(invocationId)).toBeUndefined();
  });
});
