import { SLACK_OVERLAYS } from '../../overlays/slack';
import { CANONICAL_RESPONSE_SHAPES } from '../../canonical-shapes';

describe('slack SLACK_FETCH_CONVERSATION_HISTORY (list_messages)', () => {
  const overlay = SLACK_OVERLAYS.SLACK_FETCH_CONVERSATION_HISTORY;

  it('translateInput maps canonical channelId → channel + pagination', () => {
    const out = overlay.translateInput!({ channelId: 'C123', limit: 50, pageToken: 'abc' });
    expect(out).toEqual({
      channel: 'C123', limit: 50, oldest: undefined, latest: undefined, cursor: 'abc',
    });
  });

  it('translateOutput maps Composio messages + response_metadata.next_cursor', () => {
    const composioResp = {
      messages: [{ ts: '111.222', user: 'U1', text: 'hi', channel: 'C123' }],
      response_metadata: { next_cursor: 'cur-1' },
    };
    const out = overlay.translateOutput!(composioResp);
    expect(CANONICAL_RESPONSE_SHAPES['slack.list_messages'].safeParse(out).success).toBe(true);
  });
});

describe('slack SLACK_ADD_REACTION_TO_AN_ITEM (add_reaction)', () => {
  const overlay = SLACK_OVERLAYS.SLACK_ADD_REACTION_TO_AN_ITEM;

  it('translateInput defaults reaction to "eyes" when omitted', () => {
    const out = overlay.translateInput!({ channelId: 'C1', messageId: '111.222' });
    expect(out).toEqual({ channel: 'C1', timestamp: '111.222', name: 'eyes' });
  });
});

describe('slack SLACK_SEND_MESSAGE (send_message)', () => {
  const overlay = SLACK_OVERLAYS.SLACK_SEND_MESSAGE;

  it('translateOutput conforms to slack.send_message canonical shape', () => {
    const out = overlay.translateOutput!({ ts: '111.222', channel: 'C1' });
    expect(CANONICAL_RESPONSE_SHAPES['slack.send_message'].safeParse(out).success).toBe(true);
  });

  // SLACK_SEND_MESSAGE hard-rejects the legacy `text` field ("Unsupported
  // Slack send message field(s). text: Use markdown_text for normal content").
  // Every text-ish input must be normalised to markdown_text so a model that
  // picks `text` off the schema still succeeds first try.
  it('translateInput normalises text/body to markdown_text and never emits text', () => {
    const out = overlay.translateInput!({ channel: '#ci-alerts', text: 'testing 1, 2, 3' }) as Record<string, unknown>;
    expect(out.markdown_text).toBe('testing 1, 2, 3');
    expect(out.channel).toBe('#ci-alerts');
    expect(out).not.toHaveProperty('text');
  });

  it('translateInput passes an explicit markdown_text through and maps channelId', () => {
    const out = overlay.translateInput!({ channelId: 'C01ABCD2EFG', markdown_text: 'hi *there*' }) as Record<string, unknown>;
    expect(out.markdown_text).toBe('hi *there*');
    expect(out.channel).toBe('C01ABCD2EFG');
  });
});
