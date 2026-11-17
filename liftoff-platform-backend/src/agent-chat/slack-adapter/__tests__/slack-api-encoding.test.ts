// Wire encoding for the Slack Web API.
//
// Slack parses a JSON body for WRITE methods only. A read method ignores it,
// never sees its arguments, and reports the absence as a domain error
// (users.info → user_not_found, conversations.info → invalid_arguments). That
// can silently cost every Slack turn its sender attribution while
// chat.postMessage works fine beside it, because the two failure strings look
// like a bad argument rather than a missing one.
//
// Verified against the live Slack API with one token and one user id:
//   users.info         form → ok:true       JSON → user_not_found
//   conversations.info                      JSON → invalid_arguments
//   conversations.open form → ok:true       JSON → ok:true   (a write method)

import { chooseEncoding } from '../slack-api';

/** Read a URLSearchParams body back into a plain object. */
function formOf(body: BodyInit): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of (body as URLSearchParams).entries()) out[k] = v;
  return out;
}

describe('chooseEncoding — a scalar-only payload goes as form', () => {
  it('encodes users.info as form, so the user argument actually arrives', () => {
    // The payload shape a JSON body silently breaks.
    const enc = chooseEncoding({ kind: 'json', value: { user: 'U01ABCD2EFG' } });

    expect(enc.contentType).toBe('application/x-www-form-urlencoded');
    expect(formOf(enc.body)).toEqual({ user: 'U01ABCD2EFG' });
  });

  it('encodes a scalar-only chat.postMessage as form', () => {
    const enc = chooseEncoding({
      kind: 'json',
      value: { channel: 'C1', text: 'hello', thread_ts: '1.0' },
    });

    expect(enc.contentType).toBe('application/x-www-form-urlencoded');
    expect(formOf(enc.body)).toEqual({ channel: 'C1', text: 'hello', thread_ts: '1.0' });
  });

  it('stringifies numbers and booleans rather than dropping them', () => {
    const enc = chooseEncoding({
      kind: 'json',
      value: { channel: 'C1', limit: 50, inclusive: true },
    });

    expect(formOf(enc.body)).toEqual({ channel: 'C1', limit: '50', inclusive: 'true' });
  });

  it('omits undefined and null instead of sending the literal string', () => {
    // JSON.stringify drops undefined; URLSearchParams would send "undefined".
    // Turning an absent optional argument into the literal text is the same
    // class of silent wrong-argument bug this whole function exists to end.
    const enc = chooseEncoding({
      kind: 'json',
      value: { channel: 'C1', thread_ts: undefined, ts: null },
    });

    expect(formOf(enc.body)).toEqual({ channel: 'C1' });
  });

  it('preserves unicode and newlines through form encoding', () => {
    const enc = chooseEncoding({ kind: 'json', value: { text: 'héllo 🎉\nsecond line' } });

    expect(formOf(enc.body)).toEqual({ text: 'héllo 🎉\nsecond line' });
  });
});

describe('chooseEncoding — a structured payload stays JSON', () => {
  it('keeps chat.postMessage WITH blocks as JSON', () => {
    // Form cannot represent a nested array, and only write methods take one —
    // which is exactly where Slack does parse JSON.
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }];
    const enc = chooseEncoding({ kind: 'json', value: { channel: 'C1', blocks } });

    expect(enc.contentType).toBe('application/json');
    expect(JSON.parse(enc.body as string)).toEqual({ channel: 'C1', blocks });
  });

  it('keeps views.open as JSON', () => {
    const view = { type: 'modal', blocks: [] };
    const enc = chooseEncoding({ kind: 'json', value: { trigger_id: 'T1', view } });

    expect(enc.contentType).toBe('application/json');
    expect(JSON.parse(enc.body as string)).toEqual({ trigger_id: 'T1', view });
  });
});

describe('chooseEncoding — an explicit form body is left alone', () => {
  it('passes kind:form straight through', () => {
    const enc = chooseEncoding({ kind: 'form', value: { email: 'a@b.com' } });

    expect(enc.contentType).toBe('application/x-www-form-urlencoded');
    expect(formOf(enc.body)).toEqual({ email: 'a@b.com' });
  });

  it('an empty payload is form, not an empty JSON object', () => {
    // auth.test and friends take no arguments at all.
    const enc = chooseEncoding({ kind: 'json', value: {} });

    expect(enc.contentType).toBe('application/x-www-form-urlencoded');
    expect(formOf(enc.body)).toEqual({});
  });
});

// The rule above is only worth anything if the request actually carries it.
// Testing chooseEncoding alone would keep passing if slackApiFetch stopped
// calling it — the wired-at-one-end shape that hid the original bug.
describe('slackApiFetch puts the chosen encoding on the wire', () => {
  const realFetch = global.fetch;
  let captured: { headers: Record<string, string>; body: unknown };

  beforeEach(() => {
    captured = { headers: {}, body: undefined };
    global.fetch = (async (_url: string, init: RequestInit) => {
      captured.headers = init.headers as Record<string, string>;
      captured.body = init.body;
      return { status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => { global.fetch = realFetch; });

  it('sends users.info form-encoded, with the user argument present', async () => {
    const { slackApiFetch } = await import('../slack-api');
    await slackApiFetch('users.info', {
      authToken: 'xoxb-test',
      body: { kind: 'json', value: { user: 'U01ABCD2EFG' } },
    });

    expect(captured.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(String(captured.body)).toBe('user=U01ABCD2EFG');
    expect(captured.headers.Authorization).toBe('Bearer xoxb-test');
  });

  it('still sends a blocks payload as JSON', async () => {
    const { slackApiFetch } = await import('../slack-api');
    await slackApiFetch('chat.postMessage', {
      authToken: 'xoxb-test',
      body: { kind: 'json', value: { channel: 'C1', blocks: [{ type: 'divider' }] } },
    });

    expect(captured.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(captured.body))).toEqual({ channel: 'C1', blocks: [{ type: 'divider' }] });
  });
});
