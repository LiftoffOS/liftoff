// The heuristic floor: provenance coverage for every connector without a
// hand-written declaration.
//
// It exists because hand-declaration does not scale and structurally cannot
// cover vendor-hosted MCP — `github` has zero registry functions, and github is
// the connector the code-reviewer pilot actually uses. A coverage model that
// omits the pilot's own connector is not a coverage model.
//
// The tests below are mostly about what it must NOT do. A floor that cries wolf
// gets switched off, and switching it off takes the precision layer with it.

import { spotIdentifiers, unseenWriteIdentifiers } from '../identifier-floor';
import {
  checkFloorProvenance,
  recordProvenance,
  _resetProvenanceForTesting,
} from '../record-provenance';

describe('spotIdentifiers', () => {
  it('finds ids by key name across shapes no declaration describes', async () => {
    // The github case: a vendor-hosted MCP result nobody wrote a schema for.
    const found = spotIdentifiers({
      pull_request: { number: 4127, head: { sha: 'c6d160f7' } },
      comments: [{ id: 991 }, { id: 992 }],
    });
    expect(found).toEqual(expect.arrayContaining(['4127', 'c6d160f7', '991', '992']));
  });

  it('ignores prose that happens to sit under an id-ish key', async () => {
    // A 400-character string keyed `id` is a body somebody named badly.
    expect(spotIdentifiers({ id: 'x'.repeat(400) })).toEqual([]);
    expect(spotIdentifiers({ id: 'the quick brown fox' })).toEqual([]);
  });

  it('ignores URLs', async () => {
    // A URL is a locator, not an identity. Treating one as an id would let a
    // link in a result vouch for a write to whatever it points at.
    expect(spotIdentifiers({ id: 'https://example.com/thing/5' })).toEqual([]);
  });

  it('ignores values under keys that are not id-ish', async () => {
    expect(spotIdentifiers({ subject: 'urgent', body: 'hello' })).toEqual([]);
  });

  it('does not treat a float as an identifier', async () => {
    expect(spotIdentifiers({ id: 12.5 })).toEqual([]);
  });

  it('is bounded on a large listing', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: `row-${i}` }));
    const found = spotIdentifiers({ rows });
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(20_000);
  });

  it('handles null and primitives without throwing', async () => {
    expect(spotIdentifiers(null)).toEqual([]);
    expect(spotIdentifiers('x')).toEqual([]);
    expect(spotIdentifiers(undefined)).toEqual([]);
  });
});

describe('unseenWriteIdentifiers', () => {
  it('reports a write naming something the run never read', async () => {
    expect(unseenWriteIdentifiers({ issue_id: 'abc' }, new Set(['xyz']))).toEqual(['abc']);
  });

  it('says nothing when the run read it', async () => {
    expect(unseenWriteIdentifiers({ issue_id: 'abc' }, new Set(['abc']))).toEqual([]);
  });

  it('says nothing when the write names no identifier at all', async () => {
    // A create names nothing pre-existing, so it cannot be acting on the wrong
    // thing.
    expect(unseenWriteIdentifiers({ title: 'New issue', body: 'text' }, new Set())).toEqual([]);
  });

  it('uses the SAME spotting rule as the read side', async () => {
    // Two rules would flag writes against a set built by different logic, which
    // manufactures unseen ids out of nothing.
    const readResult = { data: { thread: { id: 'T-1' } } };
    const seen = new Set(spotIdentifiers(readResult));
    expect(unseenWriteIdentifiers({ thread_id: 'T-1' }, seen)).toEqual([]);
  });
});


describe('the floor and the shape observer agree on what an identifier key is', () => {
  // They are two regexes in two files and they must classify identically: the
  // floor decides what a run has SEEN, and the observer decides what a
  // declaration would say it returns. Disagree and a declaration is generated
  // for a path the floor never records, so the write it judges has nothing able
  // to provenance it.
  //
  // Both missed every camelCase identity when first written — `threadId` has no
  // word boundary between `d` and `I` — which is most vendors' spelling.
  it.each([
    ['id'], ['task_id'], ['taskId'], ['threadId'], ['messageId'], ['fileId'],
    ['gid'], ['uuid'], ['sha'], ['slug'], ['number'], ['ts'],
  ])('%s is an identifier key on both sides', async (key) => {
    const { idBearingPaths } = await import('../observed-shapes');
    expect(spotIdentifiers({ [key]: 'V1' })).toEqual(['V1']);
    expect(idBearingPaths({ [key]: 'V1' })).toEqual([key]);
  });

  it.each([['subject'], ['body'], ['description'], ['idempotency_key_note']])(
    '%s is not an identifier key on either side',
    async (key) => {
      const { idBearingPaths } = await import('../observed-shapes');
      expect(spotIdentifiers({ [key]: 'V1' })).toEqual([]);
      expect(idBearingPaths({ [key]: 'V1' })).toEqual([]);
    },
  );
});

describe('the floor does not ask a run where it heard of itself', () => {
  // Every floor hit in the dev shadow window was this: an agent writing a file
  // under its own invocation id, flagged because it had never "read" the id
  // the platform handed it. Three of three. Flipping the gate to enforce with
  // that in place would have blocked every workspace file write.
  const INVOCATION = '08e886d8-3e86-48d0-b927-be75e5f6b0fd';
  const AGENT = '95d03afe-4522-4fa0-a2da-d6cd365cdacb';
  const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

  beforeEach(() => _resetProvenanceForTesting());

  const write = (payload: unknown) =>
    checkFloorProvenance({ invocationId: INVOCATION, payload, runContext: [AGENT, TENANT] });

  it('does not flag a path built from the run’s own invocation id', async () => {
    await recordProvenance({ invocationId: INVOCATION, declaration: undefined, payload: undefined, result: {}, isWrite: false, floor: true });
    expect(await write({ path: `/workspace/run-values/${INVOCATION}.json` })).toEqual([]);
  });

  it.each([['agent', AGENT], ['tenant', TENANT]])('does not flag the run’s own %s id', async (_l, id) => {
    await recordProvenance({ invocationId: INVOCATION, declaration: undefined, payload: undefined, result: {}, isWrite: false, floor: true });
    expect(await write({ path: `/workspace/${id}/out.txt` })).toEqual([]);
  });

  it('STILL flags a record id the run never read', async () => {
    // The floor has to keep working, or this fix trades a false positive for
    // a blind spot.
    await recordProvenance({ invocationId: INVOCATION, declaration: undefined, payload: undefined, result: {}, isWrite: false, floor: true });
    const foreign = 'd41d8cd9-8f00-4204-a980-0998ecf8427e';
    expect(await write({ recordId: foreign })).toEqual([foreign]);
  });

  it('still flags a foreign id even when the run’s own ids are alongside it', async () => {
    await recordProvenance({ invocationId: INVOCATION, declaration: undefined, payload: undefined, result: {}, isWrite: false, floor: true });
    const foreign = 'd41d8cd9-8f00-4204-a980-0998ecf8427e';
    expect(await write({ path: `/workspace/${INVOCATION}/x`, recordId: foreign })).toEqual([foreign]);
  });
});

describe('a sandbox file write is not a record mutation', () => {
  // Every floor hit in the dev shadow window was an execution_environment
  // file_write. Excluding the run's own ids fixes the observed signature, but
  // the category is wrong underneath it: a file in the run's own sandbox has a
  // generated name, is nobody's identifier, and no read could ever have
  // vouched for it. Asking the floor about it flags every file the run makes.
  const INVOCATION = 'aaaaaaaa-0000-4000-8000-000000000001';

  beforeEach(() => _resetProvenanceForTesting());

  it('is out of scope even when it names an id nothing read', async () => {
    await recordProvenance({ invocationId: INVOCATION, declaration: undefined, payload: undefined, result: {}, isWrite: false, floor: true });
    const generated = 'd41d8cd9-8f00-4204-a980-0998ecf8427e';
    expect(await checkFloorProvenance({
      invocationId: INVOCATION,
      connector: 'execution_environment',
      payload: { path: `/workspace/${generated}.json` },
    })).toEqual([]);
  });

  it('still applies to a real connector write', async () => {
    // The exemption must be a category, not a hole.
    await recordProvenance({ invocationId: INVOCATION, declaration: undefined, payload: undefined, result: {}, isWrite: false, floor: true });
    const foreign = 'd41d8cd9-8f00-4204-a980-0998ecf8427e';
    expect(await checkFloorProvenance({
      invocationId: INVOCATION,
      connector: 'google_mail',
      payload: { threadId: foreign },
    })).toEqual([foreign]);
  });

  it('applies when no connector is named, rather than defaulting to exempt', async () => {
    await recordProvenance({ invocationId: INVOCATION, declaration: undefined, payload: undefined, result: {}, isWrite: false, floor: true });
    const foreign = 'd41d8cd9-8f00-4204-a980-0998ecf8427e';
    expect(await checkFloorProvenance({
      invocationId: INVOCATION,
      payload: { recordId: foreign },
    })).toEqual([foreign]);
  });
});
