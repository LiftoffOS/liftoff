// A reply must carry a recipient, or the vendor refuses to send it.
//
// Composio rejects GMAIL_REPLY_TO_THREAD with "At least one of
// 'recipient_email', 'cc', or 'bcc' must be provided". Reply tools do not ask
// the model for a recipient — replying to a thread implies its participants —
// so the model never passes one, and the address is not something it should be
// guessing at anyway. It is a fact about the thread.
//
// Two holes, both closed here:
//   1. `translateInput` built {user_id, thread_id, message_body, is_html} and
//      DROPPED recipient_email/cc/bcc, so even a caller that supplied one lost
//      it on the way to the vendor.
//   2. There was no enrichment, so nothing filled it in.
//
// With both holes open, a reply to an inbound email fails at the vendor:
//   reply_to_thread -> success: False
//   "Value error, At least one of 'recipient_email', 'cc', or 'bcc' ..."
// The same hole had already been found and fixed for create_draft, where it was
// milder: a draft with an empty To field rather than a send that never happened.

import { GMAIL_OVERLAYS } from '../overlays/gmail';

const reply = GMAIL_OVERLAYS.GMAIL_REPLY_TO_THREAD;

describe('translateInput keeps the recipient fields', () => {
  it('carries recipient_email through', () => {
    const out = reply.translateInput!({ thread_id: 't1', message_body: 'hi', recipient_email: 'a@b.com' }) as Record<string, unknown>;
    expect(out.recipient_email).toBe('a@b.com');
    expect(out.thread_id).toBe('t1');
    expect(out.message_body).toBe('hi');
  });

  it('accepts the stable `to` spelling', () => {
    const out = reply.translateInput!({ thread_id: 't1', body: 'hi', to: 'a@b.com' }) as Record<string, unknown>;
    expect(out.recipient_email).toBe('a@b.com');
  });

  it('carries cc and bcc, which also satisfy the vendor', () => {
    const out = reply.translateInput!({ thread_id: 't1', body: 'hi', cc: 'c@d.com', bcc: 'e@f.com' }) as Record<string, unknown>;
    expect(out.cc).toBe('c@d.com');
    expect(out.bcc).toBe('e@f.com');
  });
});

describe('enrichment fills the recipient from the thread', () => {
  const thread = {
    messages: [
      { labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'support@example.com' }] } },
      { labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: '"Alex Rivera" <person@example.com>' }] } },
    ],
  };

  it('is wired onto reply_to_thread, not only create_draft', () => {
    expect(typeof reply.enrichBeforeExecute).toBe('function');
  });

  it('takes the From of the latest message this mailbox did not send', async () => {
    const out = await reply.enrichBeforeExecute!(
      { user_id: 'me', thread_id: 't1', message_body: 'hi' },
      { dispatchVendor: async () => thread } as never,
    );
    expect((out as Record<string, unknown>).recipient_email).toBe('person@example.com');
  });

  it('leaves a supplied recipient alone', async () => {
    const out = await reply.enrichBeforeExecute!(
      { thread_id: 't1', recipient_email: 'chosen@x.com' },
      { dispatchVendor: async () => { throw new Error('must not be called'); } } as never,
    );
    expect((out as Record<string, unknown>).recipient_email).toBe('chosen@x.com');
  });

  it('does not fail the call when the lookup throws', async () => {
    const args = { thread_id: 't1', message_body: 'hi' };
    const out = await reply.enrichBeforeExecute!(
      args,
      { dispatchVendor: async () => { throw new Error('vendor down'); } } as never,
    );
    expect(out).toEqual(args);
  });

  it('does nothing for a cold-outreach call with no thread', async () => {
    const args = { message_body: 'hi' };
    expect(await reply.enrichBeforeExecute!(args, { dispatchVendor: async () => thread } as never)).toEqual(args);
  });
});
