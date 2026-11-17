// The envelope has THREE producers, not two.
//
// It was written for Composio's trigger payload (`sender`, `message_text`) and
// the native watch/history shape (nested `payload.headers[]`). A companion
// routine's work source is the third: it feeds the envelope a CANONICAL LIST
// ITEM — what `list_messages` returns after the Gmail overlay projects it —
// which spells the same two fields `from` and `snippet`.
//
// Read with only the first two spellings, a list item yields an envelope with
// a correct id and threadId and a null sender and body. The agent then tells
// the customer the sender and body are missing, and escalates a message it
// could read perfectly well. One envelope contract, three producers, and only
// two of them understood.

import { buildEventMessageEnvelope } from '../event-input-envelope';

/** Exactly what `list_messages` returns per item after the overlay projects it. */
const listItem = {
  id: '1a036c76b4c8d127',
  threadId: '1a036c76b4c8d127',
  from: 'Alex Rivera <person@example.com>',
  to: 'support@example.com',
  subject: 'Help',
  date: 'Mon, 24 Aug 2026 19:36:59 -0700',
  snippet: 'How do I create agents and delete agents?',
};

describe('a canonical list item makes a usable envelope', () => {
  const env = buildEventMessageEnvelope('google_mail', listItem);

  it('resolves the sender', () => {
    expect(env.from).toBe('Alex Rivera <person@example.com>');
  });

  it('resolves the body text from the snippet', () => {
    expect(env.text).toBe('How do I create agents and delete agents?');
  });

  it('still resolves the fields that already worked', () => {
    expect(env.id).toBe('1a036c76b4c8d127');
    expect(env.threadId).toBe('1a036c76b4c8d127');
    expect(env.to).toBe('support@example.com');
    expect(env.subject).toBe('Help');
  });

  it('leaves nothing the agent would have to call null', () => {
    // The specific complaint: an envelope whose identity fields resolve and
    // whose content fields do not is worse than one that fails outright,
    // because the run proceeds and produces a confident, wrong answer.
    expect(env.from).not.toBeNull();
    expect(env.text).not.toBeNull();
  });
});

describe('the other two producers are unchanged', () => {
  it('Composio trigger payload still wins on its own spelling', () => {
    const env = buildEventMessageEnvelope('google_mail', {
      id: 'm1', thread_id: 't1',
      sender: 'customer@example.com',
      to: 'support@example.com',
      subject: 'Help',
      message_text: 'body from the trigger',
      label_ids: ['INBOX', 'UNREAD'],
    });
    expect(env.from).toBe('customer@example.com');
    expect(env.text).toBe('body from the trigger');
    expect(env.labels).toEqual(['INBOX', 'UNREAD']);
  });

  it('trigger spelling takes precedence when BOTH are present', () => {
    // `sender` is the shape the event path delivers; the
    // list-item spelling is the fallback, never an override.
    const env = buildEventMessageEnvelope('google_mail', {
      sender: 'trigger@example.com', from: 'listitem@example.com',
      message_text: 'trigger body', snippet: 'list snippet',
    });
    expect(env.from).toBe('trigger@example.com');
    expect(env.text).toBe('trigger body');
  });

  it('native nested headers still resolve', () => {
    const env = buildEventMessageEnvelope('google_mail', {
      id: 'm2', threadId: 't2',
      payload: { headers: [
        { name: 'From', value: 'native@example.com' },
        { name: 'Subject', value: 'Native' },
      ] },
    });
    expect(env.from).toBe('native@example.com');
    expect(env.subject).toBe('Native');
  });
});

describe('Outlook is not broken by the new fallback', () => {
  it('destructures the from OBJECT rather than stringifying it', () => {
    // `payload.from` on Graph is `{emailAddress:{address}}`. The new fallback
    // sits after outlookFrom, and `str()` returns null for a non-string, so the
    // object cannot leak through as "[object Object]".
    const env = buildEventMessageEnvelope('microsoft_outlook_mail', {
      id: 'm3',
      from: { emailAddress: { address: 'person@contoso.com' } },
      toRecipients: [{ emailAddress: { address: 'support@example.com' } }],
      subject: 'Outlook',
      bodyPreview: 'preview text',
    });
    expect(env.from).toBe('person@contoso.com');
    expect(env.to).toBe('support@example.com');
    expect(env.text).toBe('preview text');
  });
});
