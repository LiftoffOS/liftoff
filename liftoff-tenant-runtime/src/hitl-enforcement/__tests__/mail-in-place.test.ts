// Marking the triggering thread read is not something to ask a person about.
//
// `mark_as_read` clears the UNREAD label on the ONE thread the run was woken by.
// It sends nothing, reaches no third party, and changes no other record — it is
// how the agent records that it has dealt with the mail, and the last step of
// nearly every inbound-mail workflow.
//
// Gated, it produces an approval card reading "Mark email thread <id> as
// read". Nobody can
// meaningfully assess that, and a queue of them buries the escalations that do
// need a person — the same cost the read carve-out exists to avoid.
//
// The carve-out is held to the same identity proof as the GitHub/GitLab hosts:
// the thread named in the call must be the thread that woke the run.

import { isInPlaceReply } from '../in-place-reply';

const TRIGGER = { source: 'google_mail', threadId: '1a0253f5b18b5ca6' };
const markRead = (threadId: string, categories = ['write']) => ({
  name: 'google-mail-0105297e__mark_as_read',
  input: { user_id: 'me', thread_id: threadId },
  categories,
});

describe('the thread that woke the run', () => {
  it('is in place', () => {
    expect(isInPlaceReply(markRead('1a0253f5b18b5ca6'), TRIGGER)).toBe(true);
  });

  it('reads the trigger thread id however it is spelled', () => {
    for (const t of [
      { source: 'google_mail', thread_id: '1a0253f5b18b5ca6' },
      { source: 'google_mail', id: '1a0253f5b18b5ca6' },
    ]) {
      expect(isInPlaceReply(markRead('1a0253f5b18b5ca6'), t)).toBe(true);
    }
  });

  it('covers Outlook on the same rule', () => {
    expect(isInPlaceReply(markRead('abc'), { source: 'microsoft_outlook_mail', threadId: 'abc' })).toBe(true);
  });
});

describe('anything else still gates', () => {
  it('refuses a DIFFERENT thread', () => {
    // The whole point of the identity proof: acting on some other customer's
    // thread is not "in place".
    expect(isInPlaceReply(markRead('some-other-thread'), TRIGGER)).toBe(false);
  });

  it('refuses when the call names no thread', () => {
    expect(isInPlaceReply(
      { name: 'google-mail-0105297e__mark_as_read', input: { user_id: 'me' }, categories: ['write'] },
      TRIGGER,
    )).toBe(false);
  });

  it('refuses when the trigger carries no thread', () => {
    expect(isInPlaceReply(markRead('1a0253f5b18b5ca6'), { source: 'google_mail' })).toBe(false);
  });

  it('refuses an operation that is not on the list', () => {
    // delete_message is destructive and was never granted.
    expect(isInPlaceReply(
      { name: 'google-mail-0105297e__delete_message', input: { thread_id: '1a0253f5b18b5ca6' }, categories: ['destructive'] },
      TRIGGER,
    )).toBe(false);
  });

  it('lets a destructive or outbound tag override the list', () => {
    // The list narrows; it never overrides a tag.
    expect(isInPlaceReply(markRead('1a0253f5b18b5ca6', ['destructive']), TRIGGER)).toBe(false);
    expect(isInPlaceReply(markRead('1a0253f5b18b5ca6', ['outbound']), TRIGGER)).toBe(false);
  });

  it('refuses a mail op when the trigger was a different source', () => {
    expect(isInPlaceReply(markRead('1a0253f5b18b5ca6'), { source: 'github', threadId: '1a0253f5b18b5ca6' })).toBe(false);
  });

  it('still refuses with no trigger target at all', () => {
    expect(isInPlaceReply(markRead('1a0253f5b18b5ca6'), undefined)).toBe(false);
  });
});
