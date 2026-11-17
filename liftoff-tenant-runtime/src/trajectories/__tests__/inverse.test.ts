// Canonical → platform message list, per engine.
//
// Paired with fidelity-fixtures: the forward mapper turns a canned raw stream
// into canonical messages, and these turn canonical messages back into
// something an engine can be invoked with. A round trip through both is the
// property a cross-engine resume actually depends on.

import {
  canonicalToEngine,
  canonicalToAnthropic,
  canonicalToGemini,
  canonicalToOpenAI,
  canonicalToCodexThreadRebuild,
  canonicalToOpenCode,
  inverseMapperShipped,
} from '../inverse';
import { repairForReplay } from '../repair';
import { FIDELITY_FIXTURES } from '../fidelity-fixtures';
import type { CanonicalMessage } from '../types';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../../agent-execution/adapter/types';
import type { ExecutionEngineId } from '../../agent-execution/adapter/types';

describe('shipped-mapper gate', () => {
  // A missing inverse mapper must keep today's behaviour for that engine, not
  // produce a half-translated conversation.
  it('reports which engines have a mapper', () => {
    expect(inverseMapperShipped('claude-agent-sdk')).toBe(true);
    expect(inverseMapperShipped('google-genai')).toBe(true);
    expect(inverseMapperShipped('google-adk')).toBe(true);
    expect(inverseMapperShipped('openai-agents')).toBe(true);
    expect(inverseMapperShipped('openai-codex')).toBe(true);
    expect(inverseMapperShipped('opencode')).toBe(true);
    expect(inverseMapperShipped('unknown-legacy')).toBe(false);
  });

  it('returns undefined for an engine with no mapper', () => {
    expect(canonicalToEngine('unknown-legacy', [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])).toBeUndefined();
  });
});

describe('anthropic', () => {
  it('translates text, tool_use and tool_result directly', () => {
    const out = canonicalToAnthropic([
      { role: 'assistant', content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 't1', name: 'file_read', input: { p: '/a' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }] },
    ]);

    expect(out).toEqual([
      { role: 'assistant', content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', toolName: 'file_read', callId: 't1', args: { p: '/a' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', callId: 't1', result: 'contents' }] },
    ]);
  });

  it('carries the error flag on a failed tool result', () => {
    const out = canonicalToAnthropic([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] },
    ]);
    expect((out[0].content[0] as { error?: string }).error).toBeDefined();
  });

  it('drops a message left with no translatable content', () => {
    const out = canonicalToAnthropic([
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'OPAQUE' }] },
    ]);
    expect(out).toEqual([]);
  });
});

describe('gemini', () => {
  // Gemini REQUIRES functionResponse.name. A result whose own block carries none
  // is matched back to its call, which is the only other place the name lives.
  it('recovers a missing result name from the matching tool_use', () => {
    const out = canonicalToGemini([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fc1', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc1', content: 'ok' }] },
    ]);
    expect((out[1].content[0] as { result: { name: string } }).result.name).toBe('lookup');
  });

  it('uses the name the result carries when it has one', () => {
    const out = canonicalToGemini([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc1', name: 'search', content: 'ok' }] },
    ]);
    expect((out[0].content[0] as { result: { name: string } }).result.name).toBe('search');
  });

  // Sending a nameless functionResponse gets the whole request rejected. Losing
  // one result is recoverable; a rejected conversation is not.
  it('drops a result it can give no name at all rather than sending it nameless', () => {
    const out = canonicalToGemini([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'ok' }] },
    ]);
    expect(out).toEqual([]);
  });
});

describe('openai', () => {
  it('re-stringifies tool input into arguments', () => {
    const out = canonicalToOpenAI([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'lookup', input: { id: 42 } }] },
    ]);
    expect((out[0].content[0] as { args: string }).args).toBe('{"id":42}');
  });

  // __raw_arguments is a call whose arguments were NOT valid JSON, preserved so
  // the call would not be dropped and its result orphaned. Re-serializing it
  // would invent well-formed arguments the model never produced.
  it('replays __raw_arguments verbatim instead of re-serializing them', () => {
    const out = canonicalToOpenAI([
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'c1', name: 'lookup', input: { __raw_arguments: '{not json' } },
      ] },
    ]);
    expect((out[0].content[0] as { args: string }).args).toBe('{not json');
  });

  it('re-attaches message-scoped reasoning ids to the message they came from', () => {
    const out = canonicalToOpenAI([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        message_scoped: { responses_api_id: 'rs_1', encrypted_reasoning: 'ENC' },
      },
    ]);
    expect(out[0].providerData).toEqual({ responses_api_id: 'rs_1', encrypted_reasoning: 'ENC' });
  });

  it('sets no providerData when the message carried none', () => {
    const out = canonicalToOpenAI([
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ]);
    expect(out[0].providerData).toBeUndefined();
  });
});

describe('codex', () => {
  // Codex resumes by THREAD ID, not by transcript. This is a rebuild into a
  // fresh thread seeded with prior history — the name says so, and it should
  // keep saying so, because read as a true resume it would imply Codex-side
  // state (its todo list, its file-change ledger, its sandbox) came across.
  it('is named as a thread rebuild, and produces seeded history', () => {
    const out = canonicalToCodexThreadRebuild([
      { role: 'user', content: [{ type: 'text', text: 'earlier work' }] },
    ]);
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'earlier work' }] }]);
  });
});

describe('opencode', () => {
  it('replays a coalesced assistant turn exactly once', () => {
    const out = canonicalToOpenCode([
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] },
    ]);
    expect(out).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }] }]);
  });
});

// ── the property the whole workstream exists for ────────────────────────────
describe('every recorded conversation rebuilds onto every shipped engine', () => {
  // Derived. This is the property the workstream exists for, so the set it runs
  // over must not be a set somebody maintains beside the one that decides which
  // engines are real.
  const ENGINES: readonly ExecutionEngineId[] = RESOLVABLE_EXECUTION_ENGINE_IDS;

  for (const fixture of FIDELITY_FIXTURES) {
    for (const target of ENGINES) {
      it(`${fixture.engine} → ${target}`, () => {
        const repaired = repairForReplay(fixture.expected as CanonicalMessage[], {
          sourceEngine: fixture.engine,
          targetEngine: target,
          targetSupportsImages: false,
        });
        const messages = canonicalToEngine(target, repaired);
        expect(messages).toBeDefined();

        // No empty messages — itself a 400 on most providers.
        for (const m of messages!) expect(m.content.length).toBeGreaterThan(0);

        // Every tool call that survives is answered. An unanswered call is the
        // single most common reason a replayed conversation is rejected.
        const uses = new Set<string>();
        const results = new Set<string>();
        for (const m of messages!) {
          for (const c of m.content) {
            if (c.type === 'tool_use') uses.add(c.callId);
            if (c.type === 'tool_result') results.add(c.callId);
          }
        }
        for (const id of uses) expect(results.has(id)).toBe(true);
      });
    }
  }
});
