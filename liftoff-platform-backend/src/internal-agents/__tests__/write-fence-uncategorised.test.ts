// A graph that only READS satisfied the fence whose job is to insist something
// gets written.
//
// Both fences asked "is this step NOT a read", chosen so a tool arriving
// without categories could not fail an otherwise correct hire. That direction
// is wrong: an uncategorised READ then counts as a write.
//
// A redistill can produce a graph whose only document tools are `get_document`
// and `search_documents`. `producesDocument` is declared, the fence runs, and
// under that direction it passes: with categories it fires, without them it
// returns nothing. The agent can then no longer produce the deliverable it
// exists to produce, and nothing says so.

import { findMissingArtifactWrite, findMissingSeriesWrite } from '../distill-service';

const STORE = ['8fd9fc68-1111-2222-3333-444444444444'];
const readOnly = [
  { toolName: 'google-docs-8fd9fc68__search_documents' },
  { toolName: 'google-docs-8fd9fc68__get_document' },
  { toolName: 'have_i_acted_on' },
  { toolName: 'open_chat_thread' },
];
const withWrite = [...readOnly, { toolName: 'google-docs-8fd9fc68__update_document_markdown' }];
const noCatalog = new Map();
const catalogued = new Map([
  ['google-docs-8fd9fc68__get_document', { categories: ['read'] }],
  ['google-docs-8fd9fc68__search_documents', { categories: ['read'] }],
  ['google-docs-8fd9fc68__update_document_markdown', { categories: ['write'] }],
]) as never;

describe('a graph that never writes its artifact', () => {
  it('is caught when the catalog says the tools are reads', () => {
    expect(findMissingArtifactWrite(true, readOnly, STORE, catalogued).map(e => e.type))
      .toEqual(['missing_artifact_write']);
  });

  it('is caught when the catalog says NOTHING, which is the case that shipped', () => {
    // The regression. `catalog.get` returning undefined left cats empty, and
    // "not a read" is true of an empty list.
    expect(findMissingArtifactWrite(true, readOnly, STORE, noCatalog as never).map(e => e.type))
      .toEqual(['missing_artifact_write']);
  });

  it('accepts a write the catalog has never heard of, on its name alone', () => {
    // The property the old direction was protecting, kept: an uncatalogued tool
    // must not fail a correct hire. The name is the second signal, so it fails
    // open only when BOTH are absent.
    expect(findMissingArtifactWrite(true, withWrite, STORE, noCatalog as never)).toEqual([]);
  });

  it('still ignores a tool that belongs to no bound store', () => {
    const elsewhere = [{ toolName: 'notion-aaaaaaaa__create_page' }];
    expect(findMissingArtifactWrite(true, elsewhere, STORE, noCatalog as never).map(e => e.type))
      .toEqual(['missing_artifact_write']);
  });
});

describe('the same hole in the series fence', () => {
  it('is caught when a comparison role writes no record at all', () => {
    expect(findMissingSeriesWrite(true, readOnly, STORE, noCatalog as never).map(e => e.type))
      .toEqual(['missing_series_write']);
  });

  it('passes once the run records its own figures', () => {
    expect(findMissingSeriesWrite(true, withWrite, STORE, noCatalog as never)).toEqual([]);
  });

  it('still lapses when no store is bound, which is case (b3)', () => {
    // Deliberate: with nowhere to keep a series, the honest answer is to report
    // this period and say there is no prior one.
    expect(findMissingSeriesWrite(true, readOnly, [], noCatalog as never)).toEqual([]);
  });
});
