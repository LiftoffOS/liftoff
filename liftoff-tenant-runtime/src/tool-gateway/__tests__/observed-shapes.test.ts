// Response shapes learned from traffic, because they cannot be generated.
//
// `returnsIds` is not derivable from an input schema, and a guessed path is
// worse than no declaration: the connector LOOKS covered while every write it
// judges has nothing able to provenance it. So the precision layer's raw
// material has to come from a real response.
//
// The Google trio is the case that forced this. Their reads have no canonical
// shape and no translateOutput, so nothing could be honestly declared against
// them until a real response had been looked at.

import {
  idBearingPaths,
  observeReadShape,
  observedShapes,
  _resetObservedShapesForTesting,
} from '../observed-shapes';

beforeEach(() => _resetObservedShapesForTesting());

describe('idBearingPaths', () => {
  it('writes paths in returnsIds syntax, ready to paste', () => {
    // A path that must be rewritten before use is a path somebody rewrites
    // wrongly.
    expect(idBearingPaths({ items: [{ id: 'a', threadId: 't' }] }))
      .toEqual(['items[].id', 'items[].threadId']);
  });

  it('walks one array element, not ten thousand', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: `r${i}` }));
    expect(idBearingPaths({ rows })).toEqual(['rows[].id']);
  });

  it('finds nested identities', () => {
    expect(idBearingPaths({ data: { thread: { id: 'T1' } } })).toEqual(['data.thread.id']);
  });

  it('ignores non-identity leaves', () => {
    expect(idBearingPaths({ subject: 'hello', body: 'world' })).toEqual([]);
  });

  it('returns nothing for an empty or scalar result', () => {
    expect(idBearingPaths(null)).toEqual([]);
    expect(idBearingPaths([])).toEqual([]);
  });
});

describe('observeReadShape', () => {
  it('accumulates paths across calls without storing values', () => {
    observeReadShape('googledrive.find_file', { files: [{ id: 'F1', name: 'a.pdf' }] });
    observeReadShape('googledrive.find_file', { files: [{ id: 'F2', mimeType: 'x' }] });
    const shapes = observedShapes();
    expect(shapes['googledrive.find_file']).toEqual(['files[].id']);
    // The values must not be recoverable from what was recorded.
    expect(JSON.stringify(shapes)).not.toContain('F1');
    expect(JSON.stringify(shapes)).not.toContain('a.pdf');
  });

  it('records nothing for a result with no identities', () => {
    observeReadShape('x.y', { text: 'hello' });
    expect(observedShapes()['x.y']).toBeUndefined();
  });
});

// A path this store proposes has to be one `readIdPath` can read back.
//
// It resolves a path by splitting on '.' and matching literal keys, with `[]`
// as its only wildcard. So a map keyed by identity is not a shape: the key is
// different in the next response, and a key containing a '.' cannot be
// addressed at all. Google Docs keys `lists` by `kix.<random>` per document,
// and one document contributed twenty such paths — undeclarable, different
// every time, enough to fill the whole per-tool budget, and carrying a fragment
// of the customer's document into a store whose contract is paths, never
// values.
describe('keys that are data, not fields', () => {
  const googleDocsShaped = {
    documentId: '1aCLb-l2AXpQyLOzfFRkHTzk9tRxIXNmo9eGKmJzyP7I',
    lists: {
      'kix.105io4v78wa9': { listProperties: { nestingLevels: [{ startNumber: 1 }] } },
      'kix.1jl765rqdagf': { listProperties: { nestingLevels: [{ startNumber: 1 }] } },
    },
  };

  it('keeps the real proposal and drops the map keyed by identity', () => {
    expect(idBearingPaths(googleDocsShaped)).toEqual(['documentId']);
  });

  it('does not put a fragment of the key into any path', () => {
    // The key is per-document. A path carrying it is customer-derived data in a
    // store that promises shapes.
    expect(idBearingPaths(googleDocsShaped).join(' ')).not.toContain('kix');
  });

  it('still walks ordinary nested fields', () => {
    expect(idBearingPaths({ data: { thread: { id: 'T1' } } })).toEqual(['data.thread.id']);
    expect(idBearingPaths({ page_info: { end_cursor: 'c1' } })).toEqual([]);
    expect(idBearingPaths({ 'content-type': { id: 'x' } })).toEqual(['content-type.id']);
  });

  it('treats a key too long to be a field name as data', () => {
    const byDriveId = { ['1aCLb-l2AXpQyLOzfFRkHTzk9tRxIXNmo9eGKmJzyP7I']: { id: 'inner' } };
    expect(idBearingPaths(byDriveId)).toEqual([]);
  });

  it('leaves the array wildcard alone, which the reader does understand', () => {
    expect(idBearingPaths({ items: [{ id: 'a' }] })).toEqual(['items[].id']);
  });
});
