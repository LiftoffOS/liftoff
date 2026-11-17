// The provenance obligation's graph half.
//
// The runtime's write gate is what enforces "act only on records this run has
// read", and a gate can only HOLD a call. So a graph that writes before it
// reads is not caught by the gate in any useful sense: every one of its writes
// is held, the agent does nothing, and the shadow metric fills with what looks
// like the gate working. The graph shape has to be checked while the graph is
// still editable.
//
// The test that matters most is the ORDERING one. A net asking "does the graph
// contain a read" passes a graph that reads after it writes — and a record you
// have already changed is the one thing a read cannot vouch for, so that graph
// satisfies the letter of the check and none of its purpose.

import { findMissingProvenanceRead } from '../distill-service';

type Catalog = Map<string, { categories?: string[] }>;
const catalog = (entries: Record<string, string[]>): Catalog =>
  new Map(Object.entries(entries).map(([k, v]) => [k, { categories: v }]));

const CAT = catalog({
  get_pull_request: ['read'],
  create_review_comment: ['write'],
  list_messages: ['read'],
});

const step = (toolName: string) => ({ toolName });

// The signature takes the production ToolCatalog; a Map with the same `get`
// shape is what it actually uses, and building the real one needs a live
// connector service.
const asCatalog = (c: Catalog) => c as unknown as Parameters<typeof findMissingProvenanceRead>[2];

describe('findMissingProvenanceRead', () => {
  it('says nothing when the obligation is not declared', () => {
    expect(findMissingProvenanceRead(undefined, [step('create_review_comment')], asCatalog(CAT)))
      .toEqual([]);
  });

  it('says nothing for a graph that never writes', () => {
    // A read-only role may set the flag harmlessly. Failing it for having no
    // writes would be a rule about the flag rather than about the agent.
    expect(findMissingProvenanceRead(true, [step('get_pull_request')], asCatalog(CAT)))
      .toEqual([]);
  });

  it('accepts a read before the write', () => {
    expect(findMissingProvenanceRead(
      true,
      [step('get_pull_request'), step('create_review_comment')],
      asCatalog(CAT),
    )).toEqual([]);
  });

  it('rejects a write with no read before it', () => {
    const [issue] = findMissingProvenanceRead(true, [step('create_review_comment')], asCatalog(CAT));
    expect(issue.type).toBe('missing_provenance_read');
    expect(issue.detail).toContain('writes before it reads');
  });

  it('rejects a read placed AFTER the write', () => {
    // The whole point, and the case a presence check passes. Reading a record
    // you have already changed proves nothing about whether you should have.
    const found = findMissingProvenanceRead(
      true,
      [step('create_review_comment'), step('get_pull_request')],
      asCatalog(CAT),
    );
    expect(found).toHaveLength(1);
  });

  it('believes the catalog over the tool name', () => {
    // `send_digest` looks like a write by name; the catalog says read.
    const c = catalog({ send_digest: ['read'], update_row: ['write'] });
    expect(findMissingProvenanceRead(
      true, [step('send_digest'), step('update_row')], asCatalog(c),
    )).toEqual([]);
  });

  it('falls back to the name when the catalog has no categories', () => {
    // Uncatalogued tools are the common case, not the exception — that is how
    // producesDocument passed on a graph whose only document tools were reads.
    const empty = catalog({});
    expect(findMissingProvenanceRead(true, [step('create_issue')], asCatalog(empty)))
      .toHaveLength(1);
    expect(findMissingProvenanceRead(
      true, [step('fetch_issue'), step('create_issue')], asCatalog(empty),
    )).toEqual([]);
  });

  it('ignores steps with no tool at all', () => {
    // llm_reason and delay steps carry no toolName. Counting one as the read
    // would let a graph satisfy the obligation by thinking about it.
    expect(findMissingProvenanceRead(
      true, [{ toolName: undefined }, step('create_review_comment')], asCatalog(CAT),
    )).toHaveLength(1);
  });
});
