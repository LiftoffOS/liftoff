// A routine may narrow the agent's business. It may not widen it.
//
// A connector binding's filter is the user's own statement of which records the
// agent is for, set on the connections page. A companion routine declares its
// own selection in `workSource.toolArgs`, and nothing related the two — so one
// distillation can define the agent's business twice, in the same response,
// with the routine's copy silently the wider of the two. The event path honours
// the binding; the sweep does not, and the sweep runs every fifteen minutes.
//
// Only SCOPE is checked. State — unread, a status label, an age — is exactly
// what a routine is entitled to choose: an unread sweep wants is:unread and a
// follow-up sweep deliberately wants threads that are already read.

import { findWorkSourceWiderThanBinding } from '../distill-service';

const bindings = { '0105297e': { gmailQuery: 'is:unread to:support@example.com -label:support/handled' } };
const cron = (label: string, q?: string) => ({
  label,
  workSource: { toolName: 'gmail__list_messages', itemsPath: 'messages', source: 'google_mail',
    ...(q === undefined ? {} : { toolArgs: { q } }) },
});
const run = (crons: unknown[], cfg: unknown = bindings) =>
  findWorkSourceWiderThanBinding({ companionCrons: crons } as never, cfg as never);

describe('a routine that drops the binding scope', () => {
  it('rejects a whole-mailbox sweep', () => {
    const e = run([cron('unread-support-sweep', 'is:unread in:inbox')]);
    expect(e).toHaveLength(1);
    expect(e[0].detail).toContain('support@example.com');
  });

  it('rejects an age-only sweep', () => {
    expect(run([cron('weekly-recurring-issues', 'newer_than:7d')])).toHaveLength(1);
  });

  it('rejects a routine with no filter at all', () => {
    const e = run([cron('no-filter', undefined)]);
    expect(e[0].detail).toContain('no filter at all');
  });

  it('names the routine so it is actionable', () => {
    expect(run([cron('unread-support-sweep', 'is:unread in:inbox')])[0].stepId)
      .toBe('unread-support-sweep');
  });
});

describe('what a routine is entitled to do', () => {
  it('accepts the same scope with the same state', () => {
    expect(run([cron('unread', 'is:unread to:support@example.com -label:support/handled')])).toEqual([]);
  });

  it('accepts the same scope with DIFFERENT state', () => {
    // The follow-up sweep deliberately wants read threads. Scope carried, state
    // its own — the case that makes blanket filter-ANDing wrong.
    expect(run([cron('followup', 'to:support@example.com label:awaiting-customer')])).toEqual([]);
  });

  it('accepts a NARROWER scope', () => {
    expect(run([cron('narrow', 'to:support@example.com from:vip@acme.com is:unread')])).toEqual([]);
  });
});

describe('connectors other than Gmail', () => {
  // Connector filters are written in different languages, but the scope they
  // express is the same thing: the addresses this agent's work comes from.
  // Comparing addresses rather than each language's clause syntax means one
  // rule covers every connector whose filter is a string.
  const outlook = { 'ab12': { outlookFilter: "toRecipients/any(t:t/emailAddress/address eq 'support@example.com')" } };

  it('rejects a routine that drops an Outlook binding scope', () => {
    const e = run([cron('sweep', 'isRead eq false')], outlook);
    expect(e).toHaveLength(1);
    expect(e[0].detail).toContain('support@example.com');
  });

  it('accepts a routine that carries it, however it is written', () => {
    expect(run([cron('sweep', "isRead eq false and toRecipients/any(t:t/emailAddress/address eq 'support@example.com')")], outlook)).toEqual([]);
  });

  it('enforces every address when several connectors are bound', () => {
    const both = {
      g: { gmailQuery: 'to:support@example.com' },
      o: { outlookFilter: "toRecipients/any(t:t/emailAddress/address eq 'help@example.com')" },
    };
    expect(run([cron('one-sided', 'to:support@example.com')], both)[0].detail)
      .toContain('help@example.com');
  });
});

describe('it stays quiet when it has nothing to say', () => {
  it('no bindings configured', () => {
    expect(run([cron('any', 'is:unread in:inbox')], {})).toEqual([]);
  });

  it('a binding with no recipient scope', () => {
    expect(run([cron('any', 'is:unread in:inbox')], { x: { gmailQuery: 'is:unread' } })).toEqual([]);
  });

  it('a companion with no work source', () => {
    expect(run([{ label: 'plain' }])).toEqual([]);
  });
});
