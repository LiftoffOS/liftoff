// The same write, proposed twice by recovery of one step.
//
// A step creates a document, fails its declared output, and the recovery
// advisor proposes the same create — once per re-ask — leaving three documents
// where one was wanted.
//
// The ledger's whole job is to say "this exact call has already been made by
// this step", and the hard part is that the two sides SPELL a call differently:
// the step's own call reaches the run's record as a model-facing NAME, while a
// recovery proposal reaches the dispatcher already split into connector +
// actionType. Keying on either shape alone leaves the two unable to see each
// other, which is a ledger that is present and never hits.

import {
  StepReplayLedger,
  hydrateStepReplay,
  replayKeyForRequest,
  replayKeyForToolName,
  serialiseStepReplay,
} from '../step-replay-ledger';

const ALWAYS_MUTATING = () => true;

const CREATE = 'google-docs-8fd9fc68__create_document_markdown';
const CREATE_REQUEST = {
  connector: 'google-docs-8fd9fc68',
  actionType: 'create_document_markdown',
  payload: { title: 'Acme: Battle Card: AllAgents', body: '# Card' },
};

describe('one call, two spellings, one key', () => {
  it('reduces the model-facing name and the dispatch request to the same key', () => {
    expect(replayKeyForToolName(CREATE)).toBe(replayKeyForRequest(CREATE_REQUEST));
  });

  it('reduces the SDK-namespaced spelling to that key too', () => {
    // The Claude SDK prefixes every MCP tool; the bridge engines do not. A
    // replay that depended on which engine recorded the first attempt would hold
    // on some runs and not others.
    expect(replayKeyForToolName(`mcp__liftoff-tool-gateway__${CREATE}`))
      .toBe(replayKeyForRequest(CREATE_REQUEST));
  });

  it('keeps two connectors of the same type apart', () => {
    // A workspace with two Google Docs connections: the same function on each is
    // two different places to write, and collapsing them would answer one
    // connection's call with the other's document.
    expect(replayKeyForToolName('google-docs-AAAA__create_document_markdown'))
      .not.toBe(replayKeyForToolName('google-docs-BBBB__create_document_markdown'));
  });

  it('agrees on a bare standard tool name as well', () => {
    expect(replayKeyForToolName('note_save')).toBe(replayKeyForRequest({ connector: '', actionType: 'note_save' }));
  });
});

describe('what the ledger remembers', () => {
  it('answers a recovery proposal that repeats the step\'s own call', () => {
    const ledger = new StepReplayLedger('s13');
    ledger.record(
      [{ success: true, name: CREATE, input: CREATE_REQUEST.payload, result: { documentId: '10OzC7pB' } }],
      ALWAYS_MUTATING,
    );
    expect(ledger.lookup(CREATE_REQUEST)).toEqual({
      name: CREATE,
      result: { documentId: '10OzC7pB' },
    });
  });

  it('is indifferent to the order the arguments were written in', () => {
    // Key order does not change the call, so it does not change the key — the
    // same rule `callSignature` holds for the strike ledger.
    const ledger = new StepReplayLedger('s13');
    ledger.record([{ success: true, name: CREATE, input: { b: 2, a: 1 }, result: 'ok' }], ALWAYS_MUTATING);
    expect(ledger.lookup({ ...CREATE_REQUEST, payload: { a: 1, b: 2 } })?.result).toBe('ok');
  });

  it('lets a DIFFERENT document through', () => {
    // One step may legitimately write several things. Only the exact repeat is
    // answered; anything else is new work.
    const ledger = new StepReplayLedger('s13');
    ledger.record([{ success: true, name: CREATE, input: { title: 'Card: A' }, result: 'a' }], ALWAYS_MUTATING);
    expect(ledger.lookup({ ...CREATE_REQUEST, payload: { title: 'Card: B' } })).toBeUndefined();
  });

  it('remembers nothing about a call that FAILED', () => {
    // It performed nothing, so repeating it is the retry doing its job.
    const ledger = new StepReplayLedger('s13');
    expect(ledger.record(
      [{ success: false, name: CREATE, input: CREATE_REQUEST.payload, result: undefined }],
      ALWAYS_MUTATING,
    )).toBe(0);
    expect(ledger.lookup(CREATE_REQUEST)).toBeUndefined();
  });

  it('remembers nothing about a READ', () => {
    // Replaying a read would serve the retry stale data at exactly the moment
    // fresh data is most likely to be what makes it work.
    const ledger = new StepReplayLedger('s13');
    const search = 'google-docs-8fd9fc68__search_documents';
    expect(ledger.record(
      [{ success: true, name: search, input: { q: 'Battle Card' }, result: [] }],
      (n) => n !== search,
    )).toBe(0);
    expect(ledger.lookup({ connector: 'google-docs-8fd9fc68', actionType: 'search_documents', payload: { q: 'Battle Card' } }))
      .toBeUndefined();
  });

  it('remembers nothing about a record with no name', () => {
    // It cannot be matched against a later dispatch, and guessing which tool it
    // was is how a replay answers the wrong call.
    const ledger = new StepReplayLedger('s13');
    expect(ledger.record([{ success: true, input: {}, result: 'x' }], ALWAYS_MUTATING)).toBe(0);
    expect(ledger.size).toBe(0);
  });

  it('keeps the LATEST result when one call is recorded twice', () => {
    const ledger = new StepReplayLedger('s13');
    ledger.record([{ success: true, name: CREATE, input: { title: 'C' }, result: 'first' }], ALWAYS_MUTATING);
    ledger.record([{ success: true, name: CREATE, input: { title: 'C' }, result: 'second' }], ALWAYS_MUTATING);
    expect(ledger.size).toBe(1);
    expect(ledger.lookup({ ...CREATE_REQUEST, payload: { title: 'C' } })?.result).toBe('second');
  });

  it('remembers a call recorded from the dispatch request too', () => {
    // The recovery dispatch records what it just did, so the NEXT re-ask of the
    // same proposal replays rather than repeats. Otherwise each re-ask adds
    // another document.
    const ledger = new StepReplayLedger('s13');
    ledger.recordRequest(CREATE_REQUEST, { documentId: '1EJDvekw' });
    expect(ledger.lookup(CREATE_REQUEST)?.result).toEqual({ documentId: '1EJDvekw' });
  });

  it('matches a request recorded from a dispatch against the model-facing name', () => {
    // The two writers have to agree, or the ledger holds an entry nothing finds.
    const ledger = new StepReplayLedger('s13');
    ledger.recordRequest(CREATE_REQUEST, 'from-dispatch');
    const other = new StepReplayLedger('s13');
    other.record(
      [{ success: true, name: CREATE, input: CREATE_REQUEST.payload, result: 'from-record' }],
      ALWAYS_MUTATING,
    );
    // Same key on both sides: each ledger answers the other's lookup shape.
    expect(ledger.lookup(CREATE_REQUEST)).toBeDefined();
    expect(other.lookup(CREATE_REQUEST)).toBeDefined();
  });

  it('treats an empty payload and an absent one as the same call', () => {
    const ledger = new StepReplayLedger('s13');
    ledger.record([{ success: true, name: 'note_save', result: 'ok' }], ALWAYS_MUTATING);
    expect(ledger.lookup({ connector: '', actionType: 'note_save' })?.result).toBe('ok');
    expect(ledger.lookup({ connector: '', actionType: 'note_save', payload: {} })?.result).toBe('ok');
  });

  it('carries the step it belongs to', () => {
    expect(new StepReplayLedger('s13').stepId).toBe('s13');
  });
});

// A pause RE-DISPATCHES the step it paused on: every HITL pause site in the
// workflow loop writes `resumeAfterStepId: currentStepId` ("re-dispatch the gated
// step on approve") and the resumed loop enters from it. So a step whose write
// landed and whose later call gated runs again, whole, in ANOTHER PROCESS — and an
// in-memory ledger is empty exactly there, on the long interrupted runs most
// likely to repeat themselves. That is the same reasoning
// duplicate-outward-action.ts records for not keeping an in-process map.
describe('the ledger survives the pause that re-dispatches its step', () => {
  const seeded = () => {
    const ledger = new StepReplayLedger('s13');
    ledger.record(
      [{ success: true, name: CREATE, input: CREATE_REQUEST.payload, result: { documentId: '10OzC7pB' } }],
      ALWAYS_MUTATING,
    );
    return new Map([['s13', ledger]]);
  };

  it('carries a recorded call through a round trip and answers the same lookup', () => {
    const { payload } = serialiseStepReplay(seeded());
    const back = hydrateStepReplay(payload);
    expect(back.get('s13')!.lookup(CREATE_REQUEST)).toEqual({
      name: CREATE,
      result: { documentId: '10OzC7pB' },
    });
  });

  it('survives JSON, which is what a pause payload actually is', () => {
    const { payload } = serialiseStepReplay(seeded());
    const back = hydrateStepReplay(JSON.parse(JSON.stringify(payload)));
    expect(back.get('s13')!.lookupByToolName(CREATE, CREATE_REQUEST.payload)?.result)
      .toEqual({ documentId: '10OzC7pB' });
  });

  it('carries every step that has one, and no empty ones', () => {
    const ledgers = seeded();
    ledgers.set('s9', new StepReplayLedger('s9')); // nothing recorded
    const { payload } = serialiseStepReplay(ledgers);
    expect(Object.keys(payload)).toEqual(['s13']);
  });

  it('carries nothing for a run that recorded nothing', () => {
    expect(serialiseStepReplay(new Map()).payload).toEqual({});
    expect(serialiseStepReplay(undefined).payload).toEqual({});
    expect(hydrateStepReplay(undefined).size).toBe(0);
  });

  it('DROPS an oversized result and names it, rather than risking the pause', () => {
    // Losing the pause is far worse than losing a replay: a payload that cannot
    // be stored ends the run. A dropped entry leaves that one call dispatching as
    // it did before, and the caller logs which.
    const ledger = new StepReplayLedger('s13');
    ledger.record(
      [{ success: true, name: CREATE, input: { title: 'big' }, result: 'x'.repeat(20_000) }],
      ALWAYS_MUTATING,
    );
    const { payload, dropped } = serialiseStepReplay(new Map([['s13', ledger]]));
    expect(dropped).toEqual([CREATE]);
    expect(payload).toEqual({});
  });

  it('keeps the small entries when one entry is oversized', () => {
    const ledger = new StepReplayLedger('s13');
    ledger.record([
      { success: true, name: CREATE, input: { title: 'small' }, result: { documentId: 'a' } },
      { success: true, name: CREATE, input: { title: 'big' }, result: 'x'.repeat(20_000) },
    ], ALWAYS_MUTATING);
    const { payload, dropped } = serialiseStepReplay(new Map([['s13', ledger]]));
    expect(dropped).toEqual([CREATE]);
    expect(payload.s13).toHaveLength(1);
    expect(hydrateStepReplay(payload).get('s13')!.lookup({ ...CREATE_REQUEST, payload: { title: 'small' } })?.result)
      .toEqual({ documentId: 'a' });
  });

  it('bounds the whole carried ledger, not only each entry', () => {
    const ledger = new StepReplayLedger('s13');
    // Sixteen entries of ~6,000 characters each: every one is under the per-entry
    // cap and together they are over the ledger cap.
    for (let i = 0; i < 16; i++) {
      ledger.record(
        [{ success: true, name: CREATE, input: { n: i }, result: 'y'.repeat(6_000) }],
        ALWAYS_MUTATING,
      );
    }
    const { payload, dropped } = serialiseStepReplay(new Map([['s13', ledger]]));
    expect(dropped.length).toBeGreaterThan(0);
    expect(JSON.stringify(payload).length).toBeLessThan(80_000);
  });

  it('skips a carried entry with no key or no name rather than guessing one', () => {
    // A wrong key answers the wrong call, which is worse than not answering.
    const back = hydrateStepReplay({
      s13: [
        { key: '', name: CREATE, result: 'x' },
        { name: CREATE, result: 'y' } as unknown as { key: string; name: string; result: unknown },
        { key: 'k', name: '', result: 'z' },
      ],
    });
    expect(back.size).toBe(0);
  });
});

describe('the lookup the gateway uses', () => {
  it('answers a MODEL-FACING name and args, which is all a tool wrapper has', () => {
    // The gateway wrapper is handed the registered tool name and the model's own
    // arguments; it never sees a dispatch request.
    const ledger = new StepReplayLedger('s13');
    ledger.recordRequest(CREATE_REQUEST, { documentId: 'from-request' });
    expect(ledger.lookupByToolName(CREATE, CREATE_REQUEST.payload)?.result)
      .toEqual({ documentId: 'from-request' });
    expect(ledger.lookupByToolName(`mcp__liftoff-tool-gateway__${CREATE}`, CREATE_REQUEST.payload)?.result)
      .toEqual({ documentId: 'from-request' });
  });

  it('lets a different call through', () => {
    const ledger = new StepReplayLedger('s13');
    ledger.recordRequest(CREATE_REQUEST, 'x');
    expect(ledger.lookupByToolName(CREATE, { title: 'something else' })).toBeUndefined();
  });
});
