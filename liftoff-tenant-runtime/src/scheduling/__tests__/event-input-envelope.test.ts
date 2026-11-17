// The normalized `input.message` an event-triggered workflow addresses.
//
// The reproducer at the bottom is a real Composio payload shape. Against the
// old `inputData` shape a support agent's first step rendered `{"id":"null"}`
// and Gmail answered `400 Invalid id value`; the fields it needed were all
// present, one level down and under different names.

import { buildEventMessageEnvelope } from '../event-input-envelope';
// Imported from the CANONICAL package, not from the producer, on purpose: this
// is the test that pins the shared declaration against what this repo actually
// builds. The control plane gates writes and teaches the distiller from the
// same declaration, so a field advertised there and never produced here would
// bless a reference that fails at run time.
import { EVENT_INPUT_FIELDS } from '@liftoffos/runtime-shared-types';

describe('buildEventMessageEnvelope — Composio Gmail (the delivered shape)', () => {
  const composio = {
    attachment_list: [],
    id: 'a239502b68ecd7f7',
    message_id: 'a239502b68ecd7f7',
    thread_id: 'a239502b68ecd7f7',
    label_ids: ['UNREAD', 'IMPORTANT', 'CATEGORY_FORUMS', 'INBOX'],
    message_text: 'Can you send me a quote for the annual plan?\r\n\r\n',
    message_timestamp: '2026-08-15T22:13:40Z',
    sender: 'customer@example.com',
    to: 'support@example.com',
    subject: 'Help',
  };

  it('resolves the thread id the workflow needs', () => {
    expect(buildEventMessageEnvelope('google_mail', composio).threadId).toBe('a239502b68ecd7f7');
  });

  it('resolves sender and recipient under stable names', () => {
    const env = buildEventMessageEnvelope('google_mail', composio);
    // `sender`, not `from` — the raw key differs from the addressable one, which
    // is the entire reason the envelope exists.
    expect(env.from).toBe('customer@example.com');
    expect(env.to).toBe('support@example.com');
    expect(env.subject).toBe('Help');
    expect(env.text).toContain('Can you send me a quote');
  });

  it('returns labels as an ARRAY', () => {
    // A Set serializes to `{}` through the template layer and reads as empty to
    // evaluateCondition, so an `is:unread`-style predicate would be quietly
    // false. The Gmail predicate that held labels as a Set is gone, but any
    // workflow condition reading `input.message.labels` still needs an array.
    const labels = buildEventMessageEnvelope('google_mail', composio).labels;
    expect(Array.isArray(labels)).toBe(true);
    expect(labels).toContain('UNREAD');
  });
});

describe('buildEventMessageEnvelope — native Gmail watch shape', () => {
  it('reads headers out of the nested payload list', () => {
    const native = {
      id: 'msg_1',
      threadId: 'thread_1',
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'From', value: 'a@example.com' },
          { name: 'To', value: 'support@example.com' },
          { name: 'Subject', value: 'Native' },
        ],
        parts: [{ filename: 'invoice.pdf', body: { attachmentId: 'att1' } }],
      },
    };
    const env = buildEventMessageEnvelope('google_mail', native);
    expect(env.threadId).toBe('thread_1');
    expect(env.from).toBe('a@example.com');
    expect(env.subject).toBe('Native');
    expect(env.hasAttachment).toBe(true);
  });
});

describe('buildEventMessageEnvelope — absence is represented, never invented', () => {
  it('nulls fields the payload does not carry', () => {
    const env = buildEventMessageEnvelope('google_mail', {});
    expect(env.id).toBeNull();
    expect(env.threadId).toBeNull();
    expect(env.from).toBeNull();
    expect(env.labels).toEqual([]);
    expect(env.hasAttachment).toBe(false);
  });

  it('leaves mail fields null on a non-mail source', () => {
    const env = buildEventMessageEnvelope('github', { id: 'issue_1' });
    expect(env.id).toBe('issue_1');
    expect(env.from).toBeNull();
    expect(env.subject).toBeNull();
  });

  it('handles an undefined payload without throwing', () => {
    expect(() => buildEventMessageEnvelope('google_mail', undefined)).not.toThrow();
  });
});

describe('EVENT_INPUT_FIELDS — the declared contract', () => {
  it('every advertised mail field is actually produced', () => {
    // The list is what both validators check against and what the distiller
    // prompt teaches. If it advertises a field the builder never sets, the
    // validators bless a reference that fails at run time — the same
    // wired-at-one-end shape this whole change is about.
    const env = buildEventMessageEnvelope('google_mail', {
      id: 'm1', thread_id: 't1', sender: 'a@b.c', to: 'd@e.f',
      subject: 's', label_ids: ['INBOX'], message_text: 'hi',
    });
    for (const field of EVENT_INPUT_FIELDS.google_mail) {
      const key = field.replace('message.', '') as keyof typeof env;
      expect(env[key]).toBeDefined();
    }
  });

  it('identity sources advertise only what a non-mail payload can carry', () => {
    // GitHub carries no conversation the resolver knows, so it must NOT
    // advertise threadId. It did in the first draft of this contract, which
    // would have blessed `{{input.message.threadId}}` on a PR-triggered agent
    // and handed the step a null.
    expect(EVENT_INPUT_FIELDS.github).toEqual(['message.id']);
  });

  // The guard for the whole class. A source may advertise `message.threadId`
  // only if this repo can actually produce one for it — the advertised list and
  // the resolver are maintained in different files, in different repos, and
  // nothing else compares them.
  describe('every source advertising message.threadId can produce one', () => {
    // One representative payload per source, using the id keys its resolver
    // reads. Adding a source to EVENT_INPUT_FIELDS without adding it here fails
    // the final assertion rather than passing vacuously.
    const PAYLOADS: Record<string, Record<string, unknown>> = {
      google_mail: { thread_id: 't1' },
      microsoft_outlook_mail: { conversation_id: 'c1' },
      slack: { channel: 'C1', thread_ts: '123.456' },
      microsoft_teams: { team_id: 'T1', channel_id: 'C1', message_id: 'M1' },
      zendesk: { ticket_id: '1' },
      atlassian_jira: { issue_id: 'I1' },
      linear: { issue_id: 'I2' },
      intercom: { conversation_id: 'C2' },
      salesforce: { record_id: 'R1' },
      github: { id: 'PR1' },
    };

    const advertisingThreadId = Object.keys(EVENT_INPUT_FIELDS)
      .filter((s) => EVENT_INPUT_FIELDS[s].includes('message.threadId'));

    it.each(advertisingThreadId)('%s resolves a threadId', (source) => {
      const payload = PAYLOADS[source];
      expect(payload).toBeDefined();
      expect(buildEventMessageEnvelope(source, payload).threadId).not.toBeNull();
    });

    it('covers every declared source, so none is checked vacuously', () => {
      expect(Object.keys(PAYLOADS).sort()).toEqual(Object.keys(EVENT_INPUT_FIELDS).sort());
    });
  });
});
