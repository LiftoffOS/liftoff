// Wording for a mid-run user message injected into a live adapter session:
// attributed when the sender is known, anonymous otherwise, and always framed
// as an addition to the CURRENT task rather than a new one.

import { frameInterrupt } from '../interrupt-framing';

describe('frameInterrupt', () => {
  it('names the sender when a display name is present', () => {
    const framed = frameInterrupt({
      text: 'use the staging env instead',
      senderDisplayName: 'Ada Lovelace',
      senderAccountId: 'acc-1',
    });
    expect(framed).toContain('Ada Lovelace just sent a message while you were working');
    expect(framed).toContain('"use the staging env instead"');
    expect(framed).toContain('not a new task');
  });

  it('falls back to anonymous wording rather than inventing a sender', () => {
    const framed = frameInterrupt({
      text: 'stop using prod',
      senderDisplayName: null,
      senderAccountId: null,
    });
    expect(framed).toContain('A user message arrived while you were working');
    expect(framed).not.toContain('null');
  });

  it('treats a whitespace-only display name as absent', () => {
    const framed = frameInterrupt({
      text: 'hello',
      senderDisplayName: '   ',
      senderAccountId: null,
    });
    expect(framed).toContain('A user message arrived while you were working');
  });
});

// The conversational loop consumes a user_message ONLY after a tool result.
// An assistant_message boundary may be the LAST event of the turn, so
// consuming there would mark the message delivered and then drop it when the
// session ends with nothing left to drain the adapter's injection queue —
// the failure mode this test pins shut (found in live dev E2E).
describe('conversational signal boundary', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'service.ts'),
    'utf8',
  ) as string;

  it('gates user_message consumption on tool_call_finished', () => {
    const guard = SRC.match(
      /} else if \(event\.type === 'tool_call_finished'\) \{\s*\n\s*const interrupt = await this\.checkUserInterruptSignal/,
    );
    expect(guard).not.toBeNull();
  });

  it('still checks abort at either boundary', () => {
    expect(SRC).toContain(
      "event.type === 'tool_call_finished' || event.type === 'assistant_message'",
    );
  });
});
