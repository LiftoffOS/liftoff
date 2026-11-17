// Every writer of an assistant message must move the reply clock.
//
// This exists because the unread indicators are a denormalised timestamp on the
// thread, and a denormalised timestamp is only as good as the discipline of the
// writers that maintain it. The feature shipped correct for the two dominant
// paths (the live SSE turn and the tenant-runtime settle callback, both through
// appendMessage) and silently dead for two others that INSERT into
// agent_chat_messages directly inside their own transaction: the self-wake
// continuation delivery and the durable MCP run settle. Both are replies that
// arrive with nobody watching, which is the exact case the dots exist for, and
// both passed lint, typecheck and their own tests while never raising one.
//
// So the rule is mechanical rather than remembered: a production file that
// INSERTs into agent_chat_messages must also route its thread touch through
// touchThreadOnClient (or be chat-repository itself, which defines it). A fifth
// writer that forgets fails here instead of shipping a dead indicator.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

/** The repository module that owns the statement; not itself a "caller". */
const OWNER = join('agent-chat', 'chat-repository.ts');

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      productionFiles(p, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('every writer of agent_chat_messages maintains the reply clock', () => {
  const writers = productionFiles(SRC)
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
    .filter(({ source }) => /INSERT\s+INTO\s+agent_chat_messages/i.test(source))
    .map(({ file, source }) => ({ rel: file.slice(SRC.length + 1), source }));

  it('finds the writers at all, so a rename cannot make this vacuously pass', () => {
    // If this drops to zero the scan has stopped looking at the right tree and
    // every assertion below would pass without checking anything.
    expect(writers.length).toBeGreaterThanOrEqual(3);
  });

  it.each(writers.map((w) => w.rel))(
    '%s touches the thread through touchThreadOnClient',
    (rel) => {
      if (rel === OWNER) return; // defines the helper and calls it internally
      const source = writers.find((w) => w.rel === rel)!.source;
      expect({
        file: rel,
        usesHelper: source.includes('touchThreadOnClient'),
        hint:
          'This file INSERTs an assistant message into agent_chat_messages. Route its '
          + 'thread touch through touchThreadOnClient(client, threadId, tenantId, fromAgent) '
          + 'from agent-chat/chat-repository, passing fromAgent: true for an assistant row. '
          + 'A hand-written `UPDATE agent_chat_threads SET updated_at = NOW()` leaves '
          + 'last_agent_message_at unset, and the reply never raises an unread indicator.',
      }).toMatchObject({ usesHelper: true });
    },
  );

  // Calling the helper is not enough: calling it with fromAgent=false would
  // compile, pass the check above, and still never raise an indicator.
  const assistantOnlyWriters = writers.filter(
    (w) =>
      w.rel !== OWNER
      && /INSERT\s+INTO\s+agent_chat_messages[\s\S]{0,400}?'assistant'/i.test(w.source),
  );

  it('has assistant-only writers to check', () => {
    expect(assistantOnlyWriters.length).toBeGreaterThanOrEqual(2);
  });

  it.each(assistantOnlyWriters.map((w) => w.rel))(
    '%s passes fromAgent: true, because its only message row is a reply',
    (rel) => {
      const source = assistantOnlyWriters.find((w) => w.rel === rel)!.source;
      expect({
        file: rel,
        stampsTheReplyClock: /touchThreadOnClient\([^)]*,\s*true\s*\)/.test(source),
        hint:
          'This file only ever writes assistant rows, so its touchThreadOnClient call '
          + 'must pass fromAgent: true. Passing false updates updated_at and leaves '
          + 'last_agent_message_at untouched, which is indistinguishable from not '
          + 'calling it at all as far as the unread indicators are concerned.',
      }).toMatchObject({ stampsTheReplyClock: true });
    },
  );

  it('leaves no hand-rolled updated_at touch on agent_chat_threads outside the repository', () => {
    // The statement text lives in exactly one place. A second copy is how the
    // two halves drift back apart.
    const offenders = productionFiles(SRC)
      .map((file) => ({ rel: file.slice(SRC.length + 1), source: readFileSync(file, 'utf8') }))
      .filter(({ rel }) => rel !== OWNER)
      .filter(({ source }) =>
        /UPDATE\s+agent_chat_threads\s+SET\s+updated_at\s*=\s*NOW\(\)/i.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});
