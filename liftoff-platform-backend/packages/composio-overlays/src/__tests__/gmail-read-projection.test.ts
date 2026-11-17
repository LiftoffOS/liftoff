// A thread READ carries the words, not the transport.
//
// get_thread, get_message and read_thread all passed Gmail's raw `payload`
// through: base64 bodies, the MIME tree, an HTML duplicate of every text part,
// and the whole `Received:` chain, typically tens of thousands of characters.
//
// That puts all three above the 8 KB step-output budget on a TYPICAL call, so
// reading a thread pushes the step over the limit, offloads it to a file in the
// run workspace, and forces the next step to fetch its own predecessor's value
// back out with a tool call — which can lead an agent to request approval to
// run Python.
//
// Unlike the listing projection, a read keeps the body: this is where the agent
// needs the words. It drops encoding, structure and routing.

import { GMAIL_OVERLAYS, GMAIL_HISTORY_MAPPINGS } from '../overlays/gmail';
import { CANONICAL_RESPONSE_SHAPES } from '../canonical-shapes';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const msg = (body: string, extra: Record<string, unknown> = {}) => ({
  id: 'm1',
  threadId: 't1',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'Received', value: 'by 2002:a05 — routing '.repeat(80) },
      { name: 'From', value: '"Alex" <person@example.com>' },
      { name: 'To', value: 'support@example.com' },
      { name: 'Subject', value: 'Help please' },
      { name: 'Date', value: 'Fri, 22 Aug 2026 06:00:00 -0700' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { data: b64(body) } },
      { mimeType: 'text/html', body: { data: b64(`<div>${body}</div>`) } },
      ...(extra.parts as unknown[] ?? []),
    ],
  },
  ...extra,
});

describe('get_thread', () => {
  const out = () => GMAIL_OVERLAYS.GMAIL_FETCH_MESSAGE_BY_THREAD_ID.translateOutput!(
    { id: 't1', messages: [msg('How do I create agents?')] } as never,
  ) as { id: string; messages: Array<Record<string, unknown>> };

  it('keeps the decoded body — a read needs the words', () => {
    expect(out().messages[0].body).toBe('How do I create agents?');
  });

  it('keeps the identifying headers', () => {
    const m = out().messages[0];
    expect(m.from).toBe('"Alex" <person@example.com>');
    expect(m.subject).toBe('Help please');
    expect(m.threadId).toBe('t1');
  });

  it('drops the raw payload and the Received chain', () => {
    expect(out().messages[0]).not.toHaveProperty('payload');
    expect(JSON.stringify(out())).not.toContain('2002:a05');
  });

  it('drops the HTML duplicate', () => {
    expect(JSON.stringify(out())).not.toContain('<div>');
  });

  it('validates against the canonical shape', () => {
    expect(() => CANONICAL_RESPONSE_SHAPES['gmail.get_thread'].parse(out())).not.toThrow();
  });
});

describe('get_message and read_thread use the same projection', () => {
  it('get_message returns the projected message directly', () => {
    const out = GMAIL_OVERLAYS.GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID.translateOutput!(msg('hello') as never);
    expect((out as Record<string, unknown>).body).toBe('hello');
    expect(out).not.toHaveProperty('payload');
    expect(() => CANONICAL_RESPONSE_SHAPES['gmail.get_message'].parse(out)).not.toThrow();
  });

  it('read_thread returns projected items', () => {
    // read_thread is a HISTORY tool, mapped separately from the tool overlays.
    const overlay = GMAIL_HISTORY_MAPPINGS.find(o => o.stableName === 'read_thread')!;
    const out = overlay.translateOutput!({ messages: [msg('hi there')] } as never) as { items: Array<Record<string, unknown>> };
    expect(out.items[0].body).toBe('hi there');
    expect(out.items[0]).not.toHaveProperty('payload');
    expect(() => CANONICAL_RESPONSE_SHAPES['gmail.read_thread'].parse(out)).not.toThrow();
  });
});

describe('bounds and edges', () => {
  it('truncates a pathological body and says so', () => {
    const out = GMAIL_OVERLAYS.GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID.translateOutput!(msg('x'.repeat(50_000)) as never) as { body: string };
    expect(out.body.length).toBeLessThan(4200);
    expect(out.body).toContain('[truncated — 50000 characters total]');
  });

  it('lists attachment filenames but never their content', () => {
    const withFile = msg('see attached', {
      parts: [{ mimeType: 'application/pdf', filename: 'invoice.pdf', body: { data: b64('%PDF-BINARY-CONTENT') } }],
    });
    const out = GMAIL_OVERLAYS.GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID.translateOutput!(withFile as never) as Record<string, unknown>;
    expect(out.attachments).toEqual(['invoice.pdf']);
    expect(JSON.stringify(out)).not.toContain('PDF-BINARY');
  });

  it('survives a message with no body and no headers', () => {
    const out = GMAIL_OVERLAYS.GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID.translateOutput!({ id: 'm', threadId: 't' } as never);
    expect(() => CANONICAL_RESPONSE_SHAPES['gmail.get_message'].parse(out)).not.toThrow();
  });

  it('collapses a realistic thread under the step budget', () => {
    // The concrete regression: get_thread averaged 31,830 characters raw.
    const many = { id: 't1', messages: Array.from({ length: 8 }, () => msg('A support question about creating agents.')) };
    const projected = JSON.stringify(GMAIL_OVERLAYS.GMAIL_FETCH_MESSAGE_BY_THREAD_ID.translateOutput!(many as never));
    // The fixture is a scaled-down stand-in; production averaged 31,830 raw.
    // What matters is that the projection lands under the budget whatever
    // arrives, and by a wide margin.
    expect(JSON.stringify(many).length).toBeGreaterThan(15_000);
    expect(projected.length).toBeLessThan(8_192);
    expect(projected.length).toBeLessThan(JSON.stringify(many).length / 5);
  });
});
