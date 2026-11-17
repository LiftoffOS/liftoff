// The backstop, proven.
//
// Two hires of the same template, with the same connectors, under the same
// prompt version can differ: one carries an open_chat_thread step and the other
// does not. The prompt asks for it; the model only sometimes complies.
//
// So the obligation became a validation, and a validation with no test is a
// belief. These are the cases that decide whether it fires.

jest.mock('../../connectors/connector-service-client', () => ({}));
jest.mock('../../connectors/connector-service-cache', () => ({}));

import { hireRequiresChatThreadStep, findMissingDeliveryStep, findMissingExtractionStep, findMissingIdempotencyStep, findMissingSeriesWrite, findMissingArtifactWrite } from '../distill-service';

// Stands in for connectorTypesForRequirement, which reads the capability
// registry. The rule under test is the branching, not the registry.
const typesFor = (r: { connectorType?: string; capability?: string }) =>
  r.connectorType ? [r.connectorType] : r.capability === 'team_chat' ? ['slack', 'msteams'] : [];

const CHAT = {
  capability: 'team_chat',
  prose: { whenBound: 'post to {{pick:alert-channel}}', whenUnbound: 'open a chat thread with the review' },
};
const DOCS_READ = {
  capability: 'documents',
  prose: { whenBound: 'search the library', whenUnbound: 'search what you can reach' },
};

describe('hireRequiresChatThreadStep', () => {
  it('requires the step when the connector is unbound and the clause promises a thread', () => {
    expect(hireRequiresChatThreadStep([CHAT], new Set(), typesFor)).toBe(true);
  });

  it('does NOT require it when that connector is bound', () => {
    // The bound branch posts to a channel. Demanding a chat thread there would
    // make every connected team deliver twice.
    expect(hireRequiresChatThreadStep([CHAT], new Set(['slack']), typesFor)).toBe(false);
  });

  it('recognises any connector type that satisfies the capability', () => {
    expect(hireRequiresChatThreadStep([CHAT], new Set(['msteams']), typesFor)).toBe(false);
  });

  it('ignores an unbound connector whose clause promises no thread', () => {
    // Absence that changes what work happens, not where output goes.
    expect(hireRequiresChatThreadStep([DOCS_READ], new Set(), typesFor)).toBe(false);
  });

  it('ignores a connector with no variants at all', () => {
    expect(hireRequiresChatThreadStep([{ capability: 'team_chat' }], new Set(), typesFor)).toBe(false);
  });

  it('is true when ANY unbound connector promises a thread', () => {
    expect(hireRequiresChatThreadStep([DOCS_READ, CHAT], new Set(), typesFor)).toBe(true);
  });

  it('is false for a template with no optional connectors', () => {
    expect(hireRequiresChatThreadStep([], new Set(), typesFor)).toBe(false);
  });
});

describe('findMissingDeliveryStep', () => {
  const withStep = [{ toolName: 'tabular_enumerate' }, { toolName: 'open_chat_thread' }];
  const without = [{ toolName: 'tabular_enumerate' }, { toolName: 'google_docs__create' }];

  it('rejects a graph that promises a thread and opens none', () => {
    // The hire that came back without the step. It could ship; now it cannot.
    const errs = findMissingDeliveryStep(true, without);
    expect(errs).toHaveLength(1);
    expect(errs[0].type).toBe('missing_delivery_step');
  });

  it('tells the model what to add, not merely that it is wrong', () => {
    const [err] = findMissingDeliveryStep(true, without);
    expect(err.detail).toMatch(/open_chat_thread/);
    expect(err.detail).toMatch(/toolArgs\.body/);
  });

  it('names the escalation trap, which is the plausible wrong fix', () => {
    const [err] = findMissingDeliveryStep(true, without);
    expect(err.detail).toMatch(/escalation.*ends the run/i);
  });

  it('accepts a graph that carries the step', () => {
    expect(findMissingDeliveryStep(true, withStep)).toEqual([]);
  });

  it('says nothing when no thread was promised', () => {
    // A connected team, or a template that never mentions one.
    expect(findMissingDeliveryStep(false, without)).toEqual([]);
  });
});

// The other half of the same obligation, and the one with the longer history:
// v43, v46 and v47 each shipped an instruction to emit an extraction step, and
// the step kept not arriving. It has survived on prompt strength since, which
// is exactly what the hire-to-hire variance above shows is not a guarantee.
describe('findMissingExtractionStep', () => {
  const COLS = [{ index: 0 }, { index: 1 }, { index: 2 }];

  it('rejects a column contract the graph extracts nothing for', () => {
    const errs = findMissingExtractionStep(COLS, undefined, [{ toolName: 'google_docs__create' }]);
    expect(errs).toHaveLength(1);
    expect(errs[0].type).toBe('missing_extraction_step');
  });

  it('requires the enumerator when a row unit is declared', () => {
    // Requiring the wrong one would be worse than requiring neither: a table
    // collapsed to a single row is still a well-formed table.
    const [err] = findMissingExtractionStep(COLS, 'condition precedent', [{ toolName: 'tabular_extract' }]);
    expect(err.detail).toMatch(/tabular_enumerate/);
    expect(err.detail).toMatch(/condition precedent/);
  });

  it('requires the single-row tool when no row unit is declared', () => {
    const [err] = findMissingExtractionStep(COLS, undefined, [{ toolName: 'tabular_enumerate' }]);
    expect(err.detail).toMatch(/tabular_extract/);
  });

  it('accepts the matching tool', () => {
    expect(findMissingExtractionStep(COLS, undefined, [{ toolName: 'tabular_extract' }])).toEqual([]);
    expect(findMissingExtractionStep(COLS, 'covenant', [{ toolName: 'tabular_enumerate' }])).toEqual([]);
  });

  it('says nothing for a role with no column contract', () => {
    // Most templates declare none, and TeamBuilder agents have no template.
    expect(findMissingExtractionStep(undefined, undefined, [])).toEqual([]);
    expect(findMissingExtractionStep([], undefined, [])).toEqual([]);
  });

  it('states the column count, so the message is checkable', () => {
    const [err] = findMissingExtractionStep(COLS, undefined, []);
    expect(err.detail).toMatch(/3-column/);
  });
});

// Case (b2). The failure it prevents is the loudest of the three: an agent that
// cannot tell its own prior work from a human's posted fifteen "review ready"
// messages about one pull request in a morning.
describe('findMissingIdempotencyStep', () => {
  it('rejects a graph that must not act twice and never checks', () => {
    const errs = findMissingIdempotencyStep(true, [{ toolName: 'gmail__reply_to_thread' }]);
    expect(errs).toHaveLength(1);
    expect(errs[0].type).toBe('missing_idempotency_step');
  });

  it('tells the model the check goes BEFORE the acting step', () => {
    // Ordering is the whole point: a check after the reply has been sent
    // answers a question nobody can act on.
    const [err] = findMissingIdempotencyStep(true, []);
    expect(err.detail).toMatch(/BEFORE the step that acts/);
    expect(err.detail).toMatch(/have_i_acted_on/);
  });

  it('accepts a graph that carries the check', () => {
    expect(findMissingIdempotencyStep(true, [
      { toolName: 'have_i_acted_on' }, { toolName: 'gmail__reply_to_thread' },
    ])).toEqual([]);
  });

  it('says nothing for a role with no such promise', () => {
    // The legal analysts limit their SCOPE ("do not go looking for other
    // documents"), which is a different promise and needs no check.
    expect(findMissingIdempotencyStep(false, [])).toEqual([]);
    expect(findMissingIdempotencyStep(undefined, [])).toEqual([]);
  });
});

// Case (b3). The read half fails loudly ("nothing on record yet"); this half
// fails silently and permanently, breaking every FUTURE comparison rather than
// this one. A series with a hole in it looks exactly like a series.
describe('findMissingSeriesWrite', () => {
  const catalog = new Map<string, { name: string; description: string; categories?: string[] }>([
    ['sheets-abc12345__append_row', { name: 'a', description: 'd', categories: ['write'] }],
    ['sheets-abc12345__get_rows', { name: 'g', description: 'd', categories: ['read'] }],
    ['slack-zzz__post', { name: 'p', description: 'd', categories: ['write', 'outbound'] }],
  ]) as never;
  const STORE = ['abc12345-1111-2222-3333-444444444444'];

  it('rejects a comparison role that writes to no store', () => {
    const errs = findMissingSeriesWrite(true, [{ toolName: 'sheets-abc12345__get_rows' }], STORE, catalog);
    expect(errs).toHaveLength(1);
    expect(errs[0].type).toBe('missing_series_write');
  });

  it('does not count posting the summary to a channel as keeping a series', () => {
    // The bar that cannot be met by accident: a channel is not a store.
    const errs = findMissingSeriesWrite(true, [{ toolName: 'slack-zzz__post' }], STORE, catalog);
    expect(errs).toHaveLength(1);
  });

  it('accepts a graph that writes to the bound store', () => {
    expect(findMissingSeriesWrite(true, [{ toolName: 'sheets-abc12345__append_row' }], STORE, catalog)).toEqual([]);
  });

  it('lapses when no store is bound, which is case (b3) own rule', () => {
    // With nowhere to keep a series the honest answer is to report the current
    // figures and say there is no prior period. Demanding a write there would
    // be demanding the impossible.
    expect(findMissingSeriesWrite(true, [], [], catalog)).toEqual([]);
  });

  it('says nothing for a role that makes no comparison', () => {
    expect(findMissingSeriesWrite(false, [], STORE, catalog)).toEqual([]);
    expect(findMissingSeriesWrite(undefined, [], STORE, catalog)).toEqual([]);
  });

  it('explains that the skipped write breaks the NEXT run', () => {
    const [err] = findMissingSeriesWrite(true, [], STORE, catalog);
    expect(err.detail).toMatch(/next run/i);
    expect(err.detail).toMatch(/every execution|uneventful/i);
  });
});

// Case (b4), the one I first called unsound. It is sound when the question is
// asked branch-aware: the branch is decided by what is BOUND, which the
// distiller knows, rather than by a single required tool, which it cannot.
describe('findMissingArtifactWrite', () => {
  const catalog = new Map<string, { name: string; description: string; categories?: string[] }>([
    ['google-docs-77aa1234__create_document_markdown', { name: 'c', description: 'd', categories: ['write'] }],
    ['google-docs-77aa1234__search_documents', { name: 's', description: 'd', categories: ['read'] }],
    ['slack-zzz__post', { name: 'p', description: 'd', categories: ['write', 'outbound'] }],
  ]) as never;
  const DOCS = ['77aa1234-1111-2222-3333-444444444444'];

  it('rejects a role whose deliverable is a document and never writes one', () => {
    const errs = findMissingArtifactWrite(true, [
      { toolName: 'google-docs-77aa1234__search_documents' }, { toolName: 'slack-zzz__post' },
    ], DOCS, catalog);
    expect(errs).toHaveLength(1);
    expect(errs[0].type).toBe('missing_artifact_write');
  });

  it('accepts a graph that creates the document', () => {
    expect(findMissingArtifactWrite(true, [
      { toolName: 'google-docs-77aa1234__create_document_markdown' },
    ], DOCS, catalog)).toEqual([]);
  });

  it('lapses when there is nowhere to put a file', () => {
    // Branch three. The platform registers a generated file regardless, and
    // that step cannot be identified reliably enough to demand — a rule that
    // guessed would reject correct work, which is worse than not checking.
    expect(findMissingArtifactWrite(true, [], [], catalog)).toEqual([]);
  });

  it('says nothing for a role whose deliverable is not a file', () => {
    expect(findMissingArtifactWrite(false, [], DOCS, catalog)).toEqual([]);
    expect(findMissingArtifactWrite(undefined, [], DOCS, catalog)).toEqual([]);
  });

  it('does not accept posting about the document as producing it', () => {
    const errs = findMissingArtifactWrite(true, [{ toolName: 'slack-zzz__post' }], DOCS, catalog);
    expect(errs).toHaveLength(1);
    expect(errs[0].detail).toMatch(/has to exist/);
  });
});

// The catalog is not guaranteed to categorise every tool, and a check that
// treats "no category" as "not a write" would fail every qualifying hire rather
// than the one bad graph it exists for.
describe('an uncategorised tool is judged on its NAME, not waved through', () => {
  // This block used to assert that ANY uncategorised tool counted as a write,
  // so a hire could not fail on a tool the catalog had not classified. The
  // protection was real and the direction was wrong: "not a read" is true of an
  // empty category list, so an uncategorised READ satisfied the fence too.
  //
  // A redistill can produce a graph whose only document tools are get_document
  // and search_documents. producesDocument is declared, this fence runs, and it
  // passes if the catalog supplies no categories for either — and the agent can
  // no longer produce the deliverable it exists for.
  //
  // The name is now the second signal, so the original protection survives for
  // a tool that LOOKS like a write and only genuinely ambiguous tools fail.
  const catalog = new Map<string, { name: string; description: string; categories?: string[] }>([
    ['store-abc12345__do_something', { name: 'x', description: 'd' }],
    ['store-abc12345__push_snapshot', { name: 'y', description: 'd' }],
  ]) as never;
  const STORE = ['abc12345-1111-2222-3333-444444444444'];

  it('accepts an uncatalogued tool whose name says it writes', () => {
    const wrote = [{ toolName: 'store-abc12345__save_snapshot' }];
    expect(findMissingSeriesWrite(true, wrote, STORE, catalog)).toEqual([]);
    expect(findMissingArtifactWrite(true, wrote, STORE, catalog)).toEqual([]);
  });

  it('rejects a tool that names no effect at all, rather than assuming one', () => {
    // Fails CLOSED now. The retry feedback names the missing step, and the model
    // adding a properly-named write is a cheaper failure than an agent that
    // silently never produces its artifact.
    const ambiguous = [{ toolName: 'store-abc12345__do_something' }];
    expect(findMissingSeriesWrite(true, ambiguous, STORE, catalog)).toHaveLength(1);
    expect(findMissingArtifactWrite(true, ambiguous, STORE, catalog)).toHaveLength(1);
  });

  it('still rejects a graph that touches the store only to read', () => {
    const readOnly = new Map([['store-abc12345__get_rows', { name: 'g', description: 'd', categories: ['read'] }]]) as never;
    expect(findMissingSeriesWrite(true, [{ toolName: 'store-abc12345__get_rows' }], STORE, readOnly)).toHaveLength(1);
  });
});
