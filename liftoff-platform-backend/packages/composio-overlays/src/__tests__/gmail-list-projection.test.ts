// A listing must not carry raw MIME.
//
// `translateOutput` passed Gmail's whole message structure through as
// `payload` — base64 bodies, every part, and the full `Received:` chain, per
// message, for up to max_results messages.
//
// Listing 25 messages could return hundreds of thousands of characters to
// carry one short question. That result becomes the step's output, blows the
// 8 KB step-output budget, is offloaded to a file in the run workspace, and the
// next step then needs a tool call to read its own predecessor's value back —
// which can lead an agent to ask a human for permission to run Python against
// a file under /workspace/run-values/.
//
// Slack's shape next door was already projected. Gmail was the outlier.

import { GMAIL_OVERLAYS } from '../overlays/gmail';
import { CANONICAL_RESPONSE_SHAPES } from '../canonical-shapes';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const rawMessage = {
  id: '1a02683fbe908405',
  threadId: 'thr-1',
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'Delivered-To', value: 'person@example.com' },
      { name: 'Received', value: 'by 2002:a05:6400:344:b0:2dc — a very long chain '.repeat(40) },
      { name: 'From', value: '"Alex Rivera" <person@example.com>' },
      { name: 'To', value: 'support@example.com' },
      { name: 'Subject', value: 'Help please' },
      { name: 'Date', value: 'Thu, 21 Aug 2026 15:30:00 -0700' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64('How do I create agents and delete agents?\r\n\r\n') } },
      { mimeType: 'text/html', body: { data: b64('<div>How do I create agents and delete agents?</div>') } },
    ],
  },
};

const out = () => GMAIL_OVERLAYS.GMAIL_FETCH_EMAILS.translateOutput!(
  { messages: [rawMessage] } as never,
) as { items: Array<Record<string, unknown>> };

describe('the projection keeps what an agent reasons about', () => {
  it('extracts the headers that identify the mail', () => {
    const m = out().items[0];
    expect(m.id).toBe('1a02683fbe908405');
    expect(m.threadId).toBe('thr-1');
    expect(m.from).toBe('"Alex Rivera" <person@example.com>');
    expect(m.to).toBe('support@example.com');
    expect(m.subject).toBe('Help please');
    expect(m.date).toBe('Thu, 21 Aug 2026 15:30:00 -0700');
  });

  it('decodes the text body into a readable snippet', () => {
    expect(out().items[0].snippet).toBe('How do I create agents and delete agents?');
  });

  it('prefers text/plain over the HTML alternative', () => {
    expect(String(out().items[0].snippet)).not.toContain('<div>');
  });
});

describe('the projection drops what nobody reads', () => {
  it('carries no raw payload', () => {
    expect(out().items[0]).not.toHaveProperty('payload');
  });

  it('carries no Received chain', () => {
    expect(JSON.stringify(out())).not.toContain('2002:a05:6400');
  });

  it('collapses a 250 KB listing to something a prompt can hold', () => {
    // The concrete regression: 25 messages of raw MIME was a quarter of a
    // megabyte. Same 25 messages projected must stay far under the 8 KB
    // step-output budget that offloading exists to protect.
    const many = { messages: Array.from({ length: 25 }, () => rawMessage) };
    const projected = JSON.stringify(
      GMAIL_OVERLAYS.GMAIL_FETCH_EMAILS.translateOutput!(many as never),
    );
    const raw = JSON.stringify(many);
    // The fixture is a scaled-down version of a real listing; what matters is
    // that the projection stays under the budget regardless of how much MIME
    // arrives.
    expect(raw.length).toBeGreaterThan(50_000);
    expect(projected.length).toBeLessThan(8_192);
    expect(projected.length).toBeLessThan(raw.length / 10);
  });

  it('bounds the snippet so one enormous mail cannot undo it', () => {
    const long = { ...rawMessage, payload: { ...rawMessage.payload, parts: [
      { mimeType: 'text/plain', body: { data: b64('x'.repeat(50_000)) } },
    ] } };
    const m = (GMAIL_OVERLAYS.GMAIL_FETCH_EMAILS.translateOutput!({ messages: [long] } as never) as { items: Array<{ snippet?: string }> }).items[0];
    expect((m.snippet ?? '').length).toBeLessThanOrEqual(300);
  });
});

describe('it still satisfies the canonical shape', () => {
  it('validates against gmail.list_messages', () => {
    // The dispatcher validates every response post-translateOutput and throws
    // canonical_shape_violation on mismatch, so a projection that drifts from
    // the schema fails every call rather than just looking untidy.
    expect(() => CANONICAL_RESPONSE_SHAPES['gmail.list_messages'].parse(out())).not.toThrow();
  });

  it('tolerates a message with no body and no headers', () => {
    const bare = { id: 'm1', threadId: 't1' };
    const res = GMAIL_OVERLAYS.GMAIL_FETCH_EMAILS.translateOutput!({ messages: [bare] } as never);
    expect(() => CANONICAL_RESPONSE_SHAPES['gmail.list_messages'].parse(res)).not.toThrow();
  });
});
