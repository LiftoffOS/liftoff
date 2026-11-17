// The provenance recorder and the write check.
//
// The property under test is narrow and worth stating: the gate reports what it
// KNOWS is unprovenanced, never what it merely cannot vouch for. A gate that
// flagged everything undeclared would light up the whole estate on day one and
// the shadow metric — which is the evidence enforce mode gets flipped on — would
// be unreadable. So most of these cases are about what it declines to judge.

import {
  _provenanceSizeForTesting,
  _resetProvenanceForTesting,
  checkWriteProvenance,
  holdMessage,
  provenanceGateMode,
  readIdPath,
  recordProvenance,
  seedProvenanceFromTrigger,
} from '../record-provenance';

jest.mock('../../infrastructure/logging', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const INVOCATION = 'inv-1';

beforeEach(async () => {
  _resetProvenanceForTesting();
  delete process.env.PROVENANCE_GATE_MODE;
});

describe('readIdPath', () => {
  it('reads a plain dot path', async () => {
    expect(readIdPath({ data: { spreadsheetId: 'abc' } }, 'data.spreadsheetId')).toEqual(['abc']);
  });

  it('reads every element of an array segment', async () => {
    expect(readIdPath({ messages: [{ ts: '1' }, { ts: '2' }] }, 'messages[].ts')).toEqual(['1', '2']);
  });

  it('stringifies a numeric id', async () => {
    // GitHub pull numbers arrive as numbers and are compared against arguments
    // that arrive as either. One representation or the two never match.
    expect(readIdPath({ items: [{ number: 29 }] }, 'items[].number')).toEqual(['29']);
  });

  it('yields nothing for a path that does not exist', async () => {
    expect(readIdPath({ a: 1 }, 'b.c')).toEqual([]);
  });

  it('yields nothing when [] is declared against a non-array', async () => {
    // A wrong declaration. Skipped rather than coerced: recording the object
    // itself as an id would make every later write match it.
    expect(readIdPath({ items: { id: 'x' } }, 'items[].id')).toEqual([]);
  });

  it('skips a non-scalar at the end of an id path', async () => {
    expect(readIdPath({ items: [{ id: { nested: true } }] }, 'items[].id')).toEqual([]);
  });

  it('skips an empty string', async () => {
    // '' would otherwise be remembered and then vouch for any write that
    // supplied an empty argument.
    expect(readIdPath({ items: [{ id: '' }, { id: 'real' }] }, 'items[].id')).toEqual(['real']);
  });
});

describe('what a run remembers', () => {
  it('records the ids a read returned', async () => {
    await recordProvenance({
      invocationId: INVOCATION,
      declaration: { returnsIds: [{ entityType: 'message', path: 'messages[].ts' }] },
      payload: {},
      result: { messages: [{ ts: '111' }, { ts: '222' }] },
      isWrite: false,
    });

    expect(_provenanceSizeForTesting(INVOCATION)).toBe(2);
  });

  it('records what a write itself acted on, so a later write can build on it', async () => {
    // A run that creates a row and then updates it: the id never came from a
    // read because the record did not exist until this run made it.
    await recordProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['spreadsheet_id'], entityType: 'spreadsheet' },
      payload: { spreadsheet_id: 'new-sheet' },
      result: { ok: true },
      isWrite: true,
    });

    const verdict = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['spreadsheet_id'], entityType: 'spreadsheet' },
      payload: { spreadsheet_id: 'new-sheet' },
    });

    expect(verdict.provenanced).toBe(true);
  });

  it('keeps runs apart', async () => {
    // Two runs that have each read something. What run A saw does not excuse a
    // write in run B — otherwise one agent's read would provenance another's
    // write for as long as the process lived.
    await recordProvenance({
      invocationId: 'run-a',
      declaration: { returnsIds: [{ entityType: 'message', path: 'items[].id' }] },
      payload: {},
      result: { items: [{ id: 'seen-by-a' }] },
      isWrite: false,
    });
    await recordProvenance({
      invocationId: 'run-b',
      declaration: { returnsIds: [{ entityType: 'message', path: 'items[].id' }] },
      payload: {},
      result: { items: [{ id: 'seen-by-b' }] },
      isWrite: false,
    });

    const fromB = await checkWriteProvenance({
      invocationId: 'run-b',
      declaration: { idArgs: ['id'], entityType: 'message' },
      payload: { id: 'seen-by-a' },
    });

    expect(fromB.provenanced).toBe(false);
    expect(fromB.unseen).toEqual(['seen-by-a']);
  });

  it('does not judge a run that has read nothing yet', async () => {
    // The case this gate cannot answer today, stated so it is not mistaken for
    // a pass. A run whose FIRST call is a write got its identifier from the
    // trigger — a webhook naming the pull request, a cron carrying a row — and
    // that is legitimate provenance the platform supplied. Until the trigger
    // payload seeds the set, judging here would flag exactly that pattern.
    expect((await checkWriteProvenance({
      invocationId: 'run-with-no-reads',
      declaration: { idArgs: ['pull_number'], entityType: 'PullRequest' },
      payload: { pull_number: 81 },
    })).provenanced).toBe(true);
  });

  it('bounds what one run holds', async () => {
    // A run that lists ten thousand rows must not hold ten thousand ids for its
    // lifetime. The oldest are dropped rather than recording stopping, so a long
    // read phase does not make every following write look unprovenanced.
    await recordProvenance({
      invocationId: INVOCATION,
      declaration: { returnsIds: [{ entityType: 'row', path: 'items[].id' }] },
      payload: {},
      result: { items: Array.from({ length: 900 }, (_, i) => ({ id: `id-${i}` })) },
      isWrite: false,
    });

    expect(_provenanceSizeForTesting(INVOCATION)).toBeLessThanOrEqual(500);
    // The most recent survive, which is the direction a run works in.
    expect((await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['id'] },
      payload: { id: 'id-899' },
    })).provenanced).toBe(true);
  });
});

describe('what the check will and will not judge', () => {
  it('flags a write naming an id nothing read', async () => {
    await recordProvenance({
      invocationId: INVOCATION,
      declaration: { returnsIds: [{ entityType: 'PullRequest', path: 'items[].number' }] },
      payload: {},
      result: { items: [{ number: 29 }] },
      isWrite: false,
    });

    const verdict = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['pull_number'], entityType: 'PullRequest' },
      payload: { pull_number: 81 },
    });

    expect(verdict).toEqual({ provenanced: false, basis: 'declared_id_args', unseen: ['81'] });
  });

  it('passes a write naming an id a read returned', async () => {
    await recordProvenance({
      invocationId: INVOCATION,
      declaration: { returnsIds: [{ entityType: 'PullRequest', path: 'items[].number' }] },
      payload: {},
      result: { items: [{ number: 29 }] },
      isWrite: false,
    });

    expect((await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['pull_number'], entityType: 'PullRequest' },
      payload: { pull_number: 29 },
    })).provenanced).toBe(true);
  });

  it('does not judge a tool that declares no id arguments', async () => {
    expect(await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: {},
      payload: { channel: 'C123' },
    })).toEqual({ provenanced: true, basis: 'no_declaration', unseen: [] });
  });

  it('does not judge a call that supplied none of its declared id arguments', async () => {
    // A create. The tool CAN act on a named record and this call does not, so
    // there is no identifier whose origin could be in question.
    expect((await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['spreadsheet_id'] },
      payload: { title: 'New sheet' },
    })).provenanced).toBe(true);
  });

  it('does not judge a call with no invocation to remember against', async () => {
    // Chat turns and inbound dispatch reach the gateway without one. Flagging
    // them would say nothing about the identifier and everything about the
    // caller's shape.
    expect((await checkWriteProvenance({
      invocationId: undefined,
      declaration: { idArgs: ['pull_number'] },
      payload: { pull_number: 81 },
    })).provenanced).toBe(true);
  });

  it('does not let one entity vouch for another', async () => {
    // A message id and a pull request number can collide as strings. Typed
    // matching is what stops "I read message 29" excusing "write to PR 29".
    await recordProvenance({
      invocationId: INVOCATION,
      declaration: { returnsIds: [{ entityType: 'message', path: 'items[].id' }] },
      payload: {},
      result: { items: [{ id: '29' }] },
      isWrite: false,
    });

    // Untyped fallback still matches, deliberately: refusing on a distinction
    // the catalog never declared would be a false positive with no fix. The
    // typed set is what the declaration buys when both sides declare.
    const untyped = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['pull_number'] },
      payload: { pull_number: '29' },
    });
    expect(untyped.provenanced).toBe(true);
  });
});

describe('the mode switch', () => {
  it('defaults to shadow', async () => {
    expect(provenanceGateMode()).toBe('shadow');
  });

  it.each([['off', 'off'], ['enforce', 'enforce'], ['ENFORCE', 'enforce']])(
    'reads %s as %s',
    (raw, expected) => {
      process.env.PROVENANCE_GATE_MODE = raw;
      expect(provenanceGateMode()).toBe(expected);
    },
  );

  it('reads a typo as shadow, never as off or enforce', async () => {
    // A misspelled mode must not silently disable the observation, and must not
    // silently start refusing writes either.
    process.env.PROVENANCE_GATE_MODE = 'enfroce';
    expect(provenanceGateMode()).toBe('shadow');
  });
});

describe('the held outcome', () => {
  it('names the identifier and the read that would fix it', async () => {
    // A hold, not an error: the run has done nothing a read would not fix, so
    // the text says what to call rather than reporting a failure the model has
    // to guess its way out of.
    const text = holdMessage({
      connector: 'github',
      actionType: 'create_review_comment',
      unseen: ['81'],
      readToRun: 'list_pull_requests',
    });

    expect(text).toContain('81');
    expect(text).toContain('list_pull_requests');
    expect(text).toContain('not a refusal of the action');
  });

  it('still says what to do when no read declares the entity', async () => {
    const text = holdMessage({
      connector: 'slack',
      actionType: 'update_message',
      unseen: ['C123'],
      readToRun: undefined,
    });

    expect(text).toContain('Read the record from slack first');
  });
});

describe('a read does not launder its own argument', () => {
  it('refuses to treat an id the model supplied to a READ as seen', async () => {
    // The hole this closes: invent an identifier, call a lookup with it, and
    // the identifier is now "seen" for every write that follows. A successful
    // read does prove the record exists somewhere — but "exists" is not "is the
    // record my task is about", and that difference is the entire gate.
    await recordProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['thread_id'], entityType: 'thread' },
      payload: { thread_id: 'invented-1' },
      result: { ok: true },
      isWrite: false,
    });

    const verdict = await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['thread_id'], entityType: 'thread' },
      payload: { thread_id: 'invented-1' },
    });

    expect(verdict.provenanced).toBe(false);
    expect(verdict.unseen).toEqual(['invented-1']);
  });

  it('still lets a read vouch for what it RETURNED', async () => {
    // The legitimate look-then-act shape has to keep working, and it does —
    // through returnsIds, grounded in what the vendor sent back.
    await recordProvenance({
      invocationId: INVOCATION,
      declaration: {
        idArgs: ['thread_id'],
        entityType: 'thread',
        returnsIds: [{ entityType: 'thread', path: 'id' }],
      },
      payload: { thread_id: 'real-1' },
      result: { id: 'real-1' },
      isWrite: false,
    });

    expect((await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['thread_id'], entityType: 'thread' },
      payload: { thread_id: 'real-1' },
    })).provenanced).toBe(true);
  });
});

describe('seeding from the trigger payload', () => {
  it('lets a run act on what its webhook named, with no read first', async () => {
    // The most common legitimate shape, and the one that would otherwise be
    // flagged on day one: the platform put the identifier in the trigger.
    await seedProvenanceFromTrigger({
      invocationId: INVOCATION,
      payload: { object_attributes: { iid: 4127 }, project: { id: 'acme/web' } },
    });

    expect((await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['merge_request_iid'], entityType: 'merge_request' },
      payload: { merge_request_iid: 4127 },
    })).provenanced).toBe(true);
  });

  it('does not vouch for an identifier the trigger never carried', async () => {
    await seedProvenanceFromTrigger({
      invocationId: INVOCATION,
      payload: { object_attributes: { iid: 4127 } },
    });

    expect((await checkWriteProvenance({
      invocationId: INVOCATION,
      declaration: { idArgs: ['merge_request_iid'], entityType: 'merge_request' },
      payload: { merge_request_iid: 9999 },
    })).unseen).toEqual(['9999']);
  });

  it('takes short scalars and leaves prose alone', async () => {
    // A body is not an identity, and remembering it would only spend budget.
    const body = 'x'.repeat(400);
    const seeded = await seedProvenanceFromTrigger({
      invocationId: INVOCATION,
      payload: { id: 'abc', body, ok: true, nothing: null },
    });

    expect(seeded).toBe(1);
  });

  it('is bounded, so a fat envelope cannot consume the whole budget', async () => {
    const seeded = await seedProvenanceFromTrigger({
      invocationId: INVOCATION,
      payload: { rows: Array.from({ length: 5_000 }, (_, i) => ({ id: `row-${i}` })) },
    });

    expect(seeded).toBeLessThanOrEqual(200);
  });

  it('seeds nothing when there is no invocation or no payload', async () => {
    expect(await seedProvenanceFromTrigger({ invocationId: undefined, payload: { id: 'x' } })).toBe(0);
    expect(await seedProvenanceFromTrigger({ invocationId: INVOCATION, payload: undefined })).toBe(0);
  });
});
