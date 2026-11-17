// Per-translation tests for Gmail overlay. Validates that canonical input
// maps to the Composio vendor shape, and that vendor output maps to the
// canonical shape (and parses against CANONICAL_RESPONSE_SHAPES).

import { GMAIL_OVERLAYS } from '../../overlays/gmail';
import { CANONICAL_RESPONSE_SHAPES } from '../../canonical-shapes';

describe('gmail GMAIL_FETCH_EMAILS', () => {
  const overlay = GMAIL_OVERLAYS.GMAIL_FETCH_EMAILS;

  it('translateInput maps canonical {q, limit, pageToken} → vendor {query, max_results, page_token}', () => {
    const out = overlay.translateInput!({ q: 'is:unread', limit: 10, pageToken: 'abc' });
    expect(out).toEqual({
      user_id: 'me',
      query: 'is:unread',
      max_results: 10,
      page_token: 'abc',
      include_spam_trash: false,
    });
  });

  // The names the AGENT is actually shown.
  //
  // src/schemas/gmail.ts is auto-generated from Composio's raw tool schema, so
  // what reaches the model is `max_results` / `page_token` — and this
  // translator read only `limit`/`maxResults`/`pageToken`. A model following
  // the advertised schema correctly had its cap ignored (fell through to the
  // `?? 50` default) and its cursor dropped.
  //
  // So a step that sent `max_results: 25` got 50 messages — enough to exceed
  // the 8,192 step budget and send the run to recovery. Against the live
  // connector, the old translator gave `max_results: 3` → 50 rows and
  // `maxResults: 3` → 3 rows.
  it('translateInput honours the VENDOR names the schema advertises', () => {
    const out = overlay.translateInput!({ query: 'from:x@y.com', max_results: 25, page_token: 'cur' });
    expect(out).toMatchObject({ query: 'from:x@y.com', max_results: 25, page_token: 'cur' });
  });

  it('prefers the canonical name when both are supplied', () => {
    // Canonical is this package's own contract; the vendor spelling is the
    // tolerated fallback, exactly as the send/reply inputs already do it.
    const out = overlay.translateInput!({ q: 'a', limit: 5, max_results: 99, pageToken: 'p', page_token: 'v' });
    expect(out).toMatchObject({ max_results: 5, page_token: 'p' });
  });

  it('still defaults the cap when neither spelling is given', () => {
    expect(overlay.translateInput!({ q: 'a' })).toMatchObject({ max_results: 50 });
  });

  it('honours include_spam_trash instead of pinning it false', () => {
    // Advertised in the schema and previously hardcoded, so an agent asking for
    // it was silently refused.
    expect(overlay.translateInput!({ q: 'a', include_spam_trash: true }))
      .toMatchObject({ include_spam_trash: true });
    expect(overlay.translateInput!({ q: 'a' })).toMatchObject({ include_spam_trash: false });
  });

  it('translateOutput maps Composio messages array to canonical {items, nextPageToken}', () => {
    const composioResp = {
      messages: [
        { messageId: 'msg-1', threadId: 'thr-1', payload: { headers: [] } },
        { messageId: 'msg-2', threadId: 'thr-2', payload: { headers: [] } },
      ],
      nextPageToken: 'cursor-1',
    };
    const out = overlay.translateOutput!(composioResp);
    expect(CANONICAL_RESPONSE_SHAPES['gmail.list_messages'].safeParse(out).success).toBe(true);
    // Projected, not passed through. The raw `payload` used to be carried
    // verbatim — base64 bodies, every MIME part and the whole Received chain —
    // which could put hundreds of thousands of characters into a step output
    // to carry one short question. A listing carries what identifies a message;
    // the body is what get_thread and read_message are for. Headers are absent
    // in this fixture, so only the ids survive.
    expect(out).toEqual({
      items: [
        { id: 'msg-1', threadId: 'thr-1' },
        { id: 'msg-2', threadId: 'thr-2' },
      ],
      nextPageToken: 'cursor-1',
    });
  });
});

describe('gmail GMAIL_MODIFY_THREAD_LABELS (mark_as_read)', () => {
  const overlay = GMAIL_OVERLAYS.GMAIL_MODIFY_THREAD_LABELS;

  it('translateInput pre-fills add_label_ids=[] and remove_label_ids=[UNREAD]', () => {
    const out = overlay.translateInput!({ threadId: 'thr-1' });
    expect(out).toEqual({
      user_id: 'me',
      thread_id: 'thr-1',
      add_label_ids: [],
      remove_label_ids: ['UNREAD'],
    });
  });
});

describe('gmail GMAIL_SEND_EMAIL', () => {
  const overlay = GMAIL_OVERLAYS.GMAIL_SEND_EMAIL;

  it('translateInput maps canonical { to, cc, bcc, subject, body, isHtml, threadId }', () => {
    const out = overlay.translateInput!({
      to: 'a@b.com', cc: ['c@d.com'], subject: 's', body: 'b', isHtml: true,
    });
    expect(out).toMatchObject({
      user_id: 'me', recipient_email: 'a@b.com', cc: ['c@d.com'], subject: 's', body: 'b', is_html: true,
    });
  });

  it('translateOutput conforms to gmail.send_email canonical shape', () => {
    const out = overlay.translateOutput!({ id: 'msg-1', threadId: 'thr-1' });
    expect(CANONICAL_RESPONSE_SHAPES['gmail.send_email'].safeParse(out).success).toBe(true);
  });
});
