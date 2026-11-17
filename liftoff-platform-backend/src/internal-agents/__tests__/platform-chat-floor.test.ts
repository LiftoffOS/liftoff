// A destination with a platform floor must never resolve to a phrase that
// names nothing.
//
// The defect: "Notify {{pick:engineering-channel}} that the review is ready"
// resolved to "Notify your engineering channel" with no chat connector bound.
// The sentence still reads as an instruction, so the agent followed it and
// reported posting — a code reviewer said it had notified Slack with no Slack
// connector and no Slack tool call in the run.

import { unpickedPhraseFor, PLATFORM_CHAT_PHRASE } from '../../agent-templates/platform-destinations';
import { applyTemplatePicks } from '../distill-service';

describe('unpickedPhraseFor', () => {
  it('gives the platform surface when a floor is declared', () => {
    expect(unpickedPhraseFor({ fallback: 'your engineering channel', whenUnbound: 'platform_chat' }))
      .toBe(PLATFORM_CHAT_PHRASE);
  });

  it('leaves an object with no floor on its own fallback', () => {
    // Documents have no platform equivalent, so their phrase must not be
    // swapped for one — there is nowhere for the work to go.
    expect(unpickedPhraseFor({ fallback: 'your working folder' })).toBe('your working folder');
  });

  it('returns nothing when neither is declared, so a caller cannot substitute silence', () => {
    expect(unpickedPhraseFor({})).toBeUndefined();
  });
});

describe('the phrase reads correctly in the frames the catalog actually wrote', () => {
  // 20 of the 23 channel destinations read "Post … to X". A phrase carrying its
  // own preposition breaks every one of them, which is why this is a bare noun
  // phrase and why the frames are asserted rather than assumed.
  const FRAMES = [
    'Post the summary to {{pick:alert-channel}}: headline numbers',
    'Notify {{pick:alert-channel}} that the review is ready',
    'Notify IT in {{pick:alert-channel}} that provisioning is needed',
    'a named on-call owner, a brief in {{pick:alert-channel}}, and a handoff record',
    'flag it in {{pick:alert-channel}} as a probable quiet loss',
    'escalate to {{pick:alert-channel}} with the specific record',
    'alert {{pick:alert-channel}} for a decision',
  ];
  const fallbacks = { 'alert-channel': PLATFORM_CHAT_PHRASE };

  it.each(FRAMES)('%s', (frame) => {
    const out = applyTemplatePicks(frame, undefined, fallbacks);
    expect(out).toContain(PLATFORM_CHAT_PHRASE);
    expect(out).not.toContain('{{');
    // No doubled preposition and no dangling one.
    expect(out).not.toMatch(/\b(to|in)\s+(to|in)\b/);
  });
});

describe('a real pick still wins', () => {
  it('names the channel the person chose, not the platform', () => {
    const out = applyTemplatePicks(
      'Notify {{pick:engineering-channel}} that the review is ready',
      { 'engineering-channel': { id: 'C123', title: '#engineering' } },
      { 'engineering-channel': PLATFORM_CHAT_PHRASE },
    );
    expect(out).toContain('#engineering');
    expect(out).not.toContain(PLATFORM_CHAT_PHRASE);
  });
});
