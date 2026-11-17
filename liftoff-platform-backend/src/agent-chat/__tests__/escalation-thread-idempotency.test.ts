// The route that gives a blocked run — or a finished one with no connector — a
// chat thread a person can find.
//
// The trap: keying its idempotency on `turn_id`, which migration 294 made a
// FOREIGN KEY into agent_chat_turns. An escalation id is not a turn id, so
// every insert is rejected outright:
//
//   insert or update on table "agent_chat_messages"
//     violates foreign key constraint "agent_chat_messages_turn_fk"
//
// Both callers treat the failure as non-fatal and log a warning, so both
// features — "give a blocked run a chat thread" and "a team with no connector
// delivers into its own chat" — would be silently dead and nothing would
// report it.

import { readFileSync } from 'fs';
import { join } from 'path';

const router = readFileSync(join(__dirname, '..', 'escalation-thread-router.ts'), 'utf8');
const repo = readFileSync(join(__dirname, '..', 'chat-repository.ts'), 'utf8');
const migration = readFileSync(
  join(__dirname, '..', '..', '..', 'migrations', '414_chat_message_external_ref.sql'), 'utf8',
);

describe('what this route keys its idempotency on', () => {
  it('does not put a non-turn id in turn_id', () => {
    const call = router.slice(router.indexOf('const message = await chatRepo.appendMessage('));
    const args = call.slice(0, call.indexOf(');'));
    expect(args).not.toMatch(/^\s*escalationId,\s*$/m);
  });

  it('keys on the message\'s own ref instead', () => {
    const call = router.slice(router.indexOf('const message = await chatRepo.appendMessage('));
    expect(call.slice(0, call.indexOf(');'))).toContain('`${kind}:${escalationId}`');
  });

  it('uses the SAME value the thread is keyed on, so one redelivery lands once', () => {
    // The thread dedupes on external_thread_ref `<kind>:<id>`; the message now
    // dedupes on the same string. A retry finds one thread and one message.
    expect(router).toContain("`${kind}:${escalationId}`");
  });
});

describe('the column that key lives in', () => {
  it('exists and references nothing', () => {
    // The whole defect was a key stored in a column with a foreign key.
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS external_ref TEXT/);
    expect(migration).not.toMatch(/external_ref[^\n]*REFERENCES/);
  });

  it('is unique per tenant, and only where it is set', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS acm_external_ref_uniq/);
    expect(migration).toMatch(/\(tenant_id, external_ref\)/);
    expect(migration).toMatch(/WHERE external_ref IS NOT NULL/);
  });

  it('is written by the insert, so a redelivery still lands as 23505', () => {
    expect(repo).toMatch(/message_type, attachments, citations, turn_id, external_ref/);
    expect(repo).toContain('externalRef ?? null');
  });

  it('did not synthesise a turn to satisfy the constraint', () => {
    // A turn carries sender_account_id and feeds idx_turns_recall and the
    // embedding sweep: it is the unit of CONVERSATION recall. A fake turn for a
    // message nobody asked for would put a non-conversation into what the team
    // remembers — a worse defect than the one being fixed.
    expect(migration).not.toMatch(/INSERT INTO agent_chat_turns/i);
    // The route may NAME the table when explaining why it does not use it; what
    // it must never do is write one.
    expect(router).not.toMatch(/INSERT INTO agent_chat_turns/i);
    expect(router).not.toMatch(/createTurn/i);
  });
});
