import { renderTurnPrompt, firstTurnPrompt } from '../conversation-preamble';
import type { PlatformMessage } from '../types';

const historyPreamble = (m: PlatformMessage[]): string => renderTurnPrompt(m).preamble;
const lastUserText = (m: PlatformMessage[]): string => renderTurnPrompt(m).current;

const u = (t: string): PlatformMessage => ({ role: 'user', content: [{ type: 'text', text: t }] });
const a = (t: string): PlatformMessage => ({ role: 'assistant', content: [{ type: 'text', text: t }] });

describe('conversation-preamble', () => {
  it('single-turn autonomous run produces NO preamble (unchanged path)', () => {
    const msgs = [u('do the thing')];
    expect(historyPreamble(msgs)).toBe('');
    expect(firstTurnPrompt(msgs)).toBe('do the thing');
  });

  it('lastUserText returns the final user turn', () => {
    const msgs = [u('first'), a('reply'), u('second')];
    expect(lastUserText(msgs)).toBe('second');
  });

  it('multi-turn / resume replays prior turns as a transcript preamble', () => {
    const msgs = [u('first question'), a('an answer'), u('follow up')];
    const p = historyPreamble(msgs);
    expect(p).toContain('Conversation so far:');
    expect(p).toContain('User: first question');
    expect(p).toContain('Assistant: an answer');
    expect(p).not.toContain('follow up'); // the current turn is not in the preamble
    expect(firstTurnPrompt(msgs)).toBe(`${p}follow up`);
  });

  it('renders tool_use / tool_result turns as text (lossy but present)', () => {
    const msgs: PlatformMessage[] = [
      u('use a tool'),
      { role: 'assistant', content: [{ type: 'tool_use', toolName: 'search', args: { q: 'x' }, callId: 'c1' }] },
      { role: 'tool', content: [{ type: 'tool_result', callId: 'c1', result: { hits: 3 } }] },
      u('now summarize'),
    ];
    const p = historyPreamble(msgs);
    expect(p).toContain('called search');
    expect(p).toContain('tool result');
  });

  it('skips system turns (passed via the engine system slot)', () => {
    const msgs: PlatformMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'you are helpful' }] },
      u('hi'), a('hello'), u('bye'),
    ];
    expect(historyPreamble(msgs)).not.toContain('you are helpful');
  });
});
