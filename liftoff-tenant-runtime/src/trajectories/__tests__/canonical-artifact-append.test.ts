// The chat path accumulates its canonical conversation; the autonomous path
// replaces it. Both were `saveCanonicalArtifact`, and on chat that was wrong in
// a way no test could see because the chat write never landed at all.
//
// Two defects, one shipped on top of the other:
//
//   ORDERING — the write was an UPDATE issued inside executeTask, but the row
//   it updates is created by the handler's saveChatSessionJsonl AFTER
//   executeTask returns. On a thread's opening turn it matched nothing. Every
//   dev chat_sessions row had canonical_content NULL, which read as "the
//   feature is quiet" rather than "the feature has never once run".
//
//   TRUNCATION — snapshotCanonical buffers per INVOCATION, and a chat thread is
//   one invocation per turn. Replacing meant a ten-turn thread would store turn
//   ten and nothing else, then hand that single exchange to a rebuild as though
//   it were the whole history. An autonomous run is ONE invocation whose buffer
//   grows, so replacing is right there and appending would store every message
//   once per checkpoint.

import { jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: (...a: unknown[]) => mockQuery(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { appendCanonicalArtifact, saveCanonicalArtifact } from '../canonical-artifact';
import { sha256, canonicalSerialize } from '../../agent-execution/session-artifact-envelope';
import type { CanonicalMessage } from '../types';

function msg(text: string): CanonicalMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] } as CanonicalMessage;
}

/** What the loader will accept back: matching schema version, and a checksum
 *  over the ORDER-INDEPENDENT serialization — the same one the writer stamps.
 *  Using plain JSON.stringify here reproduces the shipped defect, and these
 *  tests fail against it, which is the point. */
function storedRow(messages: CanonicalMessage[]) {
  return {
    canonical_content: messages,
    canonical_schema_version: '1.1',
    canonical_sha256: sha256(canonicalSerialize(messages)),
    execution_engine: 'claude-agent-sdk',
  };
}

/** The UPDATE's messages parameter, parsed back out of the call. */
function writtenMessages(): CanonicalMessage[] | undefined {
  const update = mockQuery.mock.calls.find(
    ([sql]) => typeof sql === 'string' && (sql as string).includes('UPDATE'),
  );
  if (!update) return undefined;
  const params = update[1] as unknown[];
  return JSON.parse(params[2] as string) as CanonicalMessage[];
}

beforeEach(() => mockQuery.mockReset());

describe('appendCanonicalArtifact', () => {
  it('adds this turn onto the conversation already stored', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) {
        return { rows: [storedRow([msg('turn one')])] };
      }
      return { rows: [] };
    });

    await appendCanonicalArtifact({ kind: 'chat', threadId: 't1' }, 'agent-1', {
      messages: [msg('turn two')],
      schemaVersion: '1.1',
    });

    expect(writtenMessages()).toEqual([msg('turn one'), msg('turn two')]);
  });

  it('keeps every turn across a multi-turn thread rather than the last one', async () => {
    let stored: CanonicalMessage[] = [];
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) {
        return { rows: stored.length ? [storedRow(stored)] : [] };
      }
      stored = JSON.parse(params[2] as string) as CanonicalMessage[];
      return { rows: [] };
    });

    for (const t of ['one', 'two', 'three']) {
      await appendCanonicalArtifact({ kind: 'chat', threadId: 't1' }, 'agent-1', {
        messages: [msg(t)],
        schemaVersion: '1.1',
      });
    }

    expect(stored).toEqual([msg('one'), msg('two'), msg('three')]);
  });

  it('writes the opening turn when there is nothing stored yet', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) return { rows: [] };
      return { rows: [] };
    });

    await appendCanonicalArtifact({ kind: 'chat', threadId: 't1' }, 'agent-1', {
      messages: [msg('first')],
      schemaVersion: '1.1',
    });

    expect(writtenMessages()).toEqual([msg('first')]);
  });

  // Appending onto bytes we already declined to read would build a conversation
  // on a foundation we do not trust. Replacing is the recoverable choice.
  it('replaces, rather than appends to, a stored copy that fails its checksum', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) {
        return {
          rows: [{
            canonical_content: [msg('corrupt')],
            canonical_schema_version: '1.1',
            canonical_sha256: 'not-the-right-hash',
            execution_engine: 'claude-agent-sdk',
          }],
        };
      }
      return { rows: [] };
    });

    await appendCanonicalArtifact({ kind: 'chat', threadId: 't1' }, 'agent-1', {
      messages: [msg('fresh')],
      schemaVersion: '1.1',
    });

    expect(writtenMessages()).toEqual([msg('fresh')]);
  });

  it('never writes an empty turn over a good conversation', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [storedRow([msg('kept')])] }));

    await appendCanonicalArtifact({ kind: 'chat', threadId: 't1' }, 'agent-1', {
      messages: [],
      schemaVersion: '1.1',
    });

    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('saveCanonicalArtifact stays a replace', () => {
  // The autonomous path checkpoints repeatedly within ONE invocation whose
  // buffer already holds everything so far. If this ever became an append, each
  // checkpoint would re-add the whole conversation to itself.
  it('writes exactly the snapshot it was given, ignoring what is stored', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [] }));

    await saveCanonicalArtifact({ kind: 'autonomous', triggerKey: 'k1' }, 'agent-1', {
      messages: [msg('a'), msg('b')],
      schemaVersion: '1.1',
    });

    expect(writtenMessages()).toEqual([msg('a'), msg('b')]);
    // No read: a replace has no reason to look first, and looking would be the
    // first step toward accidentally turning this into an append.
    const selects = mockQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && (sql as string).trim().startsWith('SELECT'),
    );
    expect(selects).toHaveLength(0);
  });

  it('targets agent_run_sessions by trigger_key and chat_sessions by thread_id', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [] }));

    await saveCanonicalArtifact({ kind: 'autonomous', triggerKey: 'k1' }, 'agent-1', {
      messages: [msg('x')], schemaVersion: '1.1',
    });
    const autonomousSql = String(mockQuery.mock.calls[0][0]);
    expect(autonomousSql).toContain('agent_run_sessions');
    expect(autonomousSql).toContain('trigger_key');

    mockQuery.mockReset();
    mockQuery.mockImplementation(async () => ({ rows: [] }));
    await saveCanonicalArtifact({ kind: 'chat', threadId: 't1' }, 'agent-1', {
      messages: [msg('x')], schemaVersion: '1.1',
    });
    const chatSql = String(mockQuery.mock.calls[0][0]);
    expect(chatSql).toContain('chat_sessions');
    expect(chatSql).toContain('thread_id');
  });
});

// The defect that made every canonical row unreadable from the day the column
// shipped, and the reason none of the above could have been noticed sooner.
//
// canonical_content is a jsonb column, and jsonb SORTS object keys — by length,
// then bytewise. A payload written as {"type":..,"text":..} reads back as
// {"text":..,"type":..}. The checksum was taken with JSON.stringify before the
// write and re-taken with JSON.stringify after the read, so it compared two
// different strings describing identical content and never matched. Every
// loadCanonicalArtifact declined its row as corrupt, which means the
// cross-engine rebuild the whole record exists for could not fire once.
describe('canonicalSerialize', () => {
  it('is independent of key order, which is what jsonb does not preserve', () => {
    const written = [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];
    // Exactly what Postgres hands back for the payload above.
    const readBack = [{ content: [{ text: 'hi', type: 'text' }], role: 'assistant' }];

    expect(JSON.stringify(written)).not.toEqual(JSON.stringify(readBack));
    expect(canonicalSerialize(written)).toEqual(canonicalSerialize(readBack));
    expect(sha256(canonicalSerialize(written))).toEqual(sha256(canonicalSerialize(readBack)));
  });

  it('keeps ARRAY order, which carries the conversation', () => {
    const a = canonicalSerialize([{ n: 1 }, { n: 2 }]);
    const b = canonicalSerialize([{ n: 2 }, { n: 1 }]);
    expect(a).not.toEqual(b);
  });

  it('sorts nested objects all the way down', () => {
    const x = canonicalSerialize({ b: { d: 1, c: { f: 1, e: 2 } }, a: 1 });
    const y = canonicalSerialize({ a: 1, b: { c: { e: 2, f: 1 }, d: 1 } });
    expect(x).toEqual(y);
  });

  it('leaves primitives and nulls alone', () => {
    expect(canonicalSerialize({ a: null, b: 'x', c: 3, d: true })).toEqual(
      '{"a":null,"b":"x","c":3,"d":true}',
    );
  });
});

describe('a row survives the jsonb key reordering it will actually experience', () => {
  it('loads a stored copy whose keys came back in a different order', async () => {
    const written = [{ role: 'assistant', content: [{ type: 'text', text: 'kept' }] }] as unknown as CanonicalMessage[];
    const reordered = [{ content: [{ text: 'kept', type: 'text' }], role: 'assistant' }];

    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) {
        return {
          rows: [{
            canonical_content: reordered, // what Postgres returns
            canonical_schema_version: '1.1',
            canonical_sha256: sha256(canonicalSerialize(written)), // what we stored
            execution_engine: 'claude-agent-sdk',
          }],
        };
      }
      return { rows: [] };
    });

    await appendCanonicalArtifact({ kind: 'chat', threadId: 't1' }, 'agent-1', {
      messages: [msg('next')],
      schemaVersion: '1.1',
    });

    // Appended, not replaced — which only happens if the checksum matched.
    expect(writtenMessages()).toHaveLength(2);
  });
});
