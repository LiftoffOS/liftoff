// The identifier the platform handed the agent counts as read.
//
// The seen-set is fed by tool RESULTS and by nothing else, so an id that
// arrived in the triggering event was never seen — and a triggered agent doing
// the most ordinary thing it can do, replying to the thread the event named,
// writes to an identifier this run "has not read".
//
// Under shadow that is a warning. Under enforce it is a REFUSAL, and it would
// land on the legitimate majority rather than on the fabrications the gate
// exists for. Dev's only two shadow would-blocks were both `create_draft`
// naming `ffffffffffffffff`, which is a genuine catch; this is the class that
// would have sat beside them the moment a real reply-to-thread ran.
import {
  seedProvenanceFromEvent,
  seedProvenanceFromContext,
  checkWriteProvenance,
  recordProvenance,
  _resetProvenanceForTesting,
} from '../record-provenance';

/** A run that has read SOMETHING, which is what makes it judgeable at all: a
 *  run with nothing recorded returns `no_declaration` and is never flagged. So
 *  the false positive needs an agent that did some work first — which is every
 *  real one. */
const havingReadSomething = async (invocationId: string): Promise<void> => {
  await recordProvenance({
    invocationId,
    declaration: undefined,
    payload: undefined,
    result: { messages: [{ id: 'unrelated-message-id-0001' }] },
    isWrite: false,
    floor: true,
  });
};

const THREAD = '18c4f2a9b3d4e5f6';
const EVENT = {
  eventSource: 'google_mail',
  eventEntityType: 'Thread',
  eventData: { thread_id: THREAD, from: 'someone@example.test' },
};

beforeEach(() => _resetProvenanceForTesting());

describe('an id delivered by the triggering event', () => {
  it('is refused BEFORE seeding — the defect this fixes', async () => {
    await havingReadSomething('inv-1');
    const verdict = await checkWriteProvenance({
      invocationId: 'inv-1',
      declaration: { idArgs: ['thread_id'] },
      payload: { thread_id: THREAD },
    });
    expect(verdict.provenanced).toBe(false);
  });

  it('is accepted after seeding', async () => {
    await havingReadSomething('inv-1');
    await seedProvenanceFromEvent({ invocationId: 'inv-1', inputData: EVENT });
    const verdict = await checkWriteProvenance({
      invocationId: 'inv-1',
      declaration: { idArgs: ['thread_id'] },
      payload: { thread_id: THREAD },
    });
    expect(verdict.provenanced).toBe(true);
  });

  it('still refuses an identifier the event did NOT name', async () => {
    // The whole point. Seeding must widen what the run legitimately knows, not
    // wave through whatever it writes next — a fabricated thread id in the
    // right shape is exactly what dev's two would-blocks were.
    await havingReadSomething('inv-1');
    await seedProvenanceFromEvent({ invocationId: 'inv-1', inputData: EVENT });
    const verdict = await checkWriteProvenance({
      invocationId: 'inv-1',
      declaration: { idArgs: ['thread_id'] },
      payload: { thread_id: 'ffffffffffffffff' },
    });
    expect(verdict.provenanced).toBe(false);
  });

  it('does not leak one run\'s event ids into another', async () => {
    await seedProvenanceFromEvent({ invocationId: 'inv-1', inputData: EVENT });
    await havingReadSomething('inv-2');
    const verdict = await checkWriteProvenance({
      invocationId: 'inv-2',
      declaration: { idArgs: ['thread_id'] },
      payload: { thread_id: THREAD },
    });
    expect(verdict.provenanced).toBe(false);
  });

  it('is a no-op for a run nothing triggered', async () => {
    expect(await seedProvenanceFromEvent({ invocationId: 'inv-1', inputData: undefined })).toBe(0);
    expect(await seedProvenanceFromEvent({ invocationId: 'inv-1', inputData: { objective: 'x' } })).toBe(0);
    expect(await seedProvenanceFromEvent({ invocationId: undefined, inputData: EVENT })).toBe(0);
  });
});


// The other three ways an agent legitimately knows an identifier.
//
// It read one with a tool, the event named one, ITS OWN CONFIGURATION names
// one, THE PERSON ASKED about one, or IT IS CONTINUING work where one already
// appeared. Only the first two were recorded, so the last three read as
// fabrication — and under enforcement they are refusals landing on ordinary
// work.
//
// None of these mention which app the write is going to, which is the whole
// point: a connector added tomorrow at a customer's request, that nobody here
// has an account on and whose traffic nobody can watch, inherits all of them on
// the day it is connected.
describe('the rest of what a run was legitimately given', () => {
  const check = async (invocationId: string, id: string) =>
    (await checkWriteProvenance({
      invocationId,
      declaration: { idArgs: ['thread_id'] },
      payload: { thread_id: id },
    })).provenanced;

  it("accepts an id named by the agent's own configuration", async () => {
    await havingReadSomething('inv-1');
    await seedProvenanceFromContext({
      invocationId: 'inv-1',
      structured: { integrations: [{ channel_id: 'C0FIXEDCHANNEL' }] },
    });
    expect(await check('inv-1', 'C0FIXEDCHANNEL')).toBe(true);
  });

  it('accepts an id the person asked about', async () => {
    await havingReadSomething('inv-1');
    await seedProvenanceFromContext({
      invocationId: 'inv-1',
      texts: ['please reply on thread 18c4f2a9b3d4e5f6 before noon'],
    });
    expect(await check('inv-1', '18c4f2a9b3d4e5f6')).toBe(true);
  });

  it('accepts an id from the conversation it is continuing', async () => {
    // The resumed case. This store is per-invocation and in-process, so a run
    // that comes back in another instance has forgotten what it read and would
    // flag its own earlier work.
    await havingReadSomething('inv-1');
    await seedProvenanceFromContext({
      invocationId: 'inv-1',
      texts: ['[tool result] {"thread_id":"18c4f2a9b3d4e5f6","subject":"Invoice"}'],
    });
    expect(await check('inv-1', '18c4f2a9b3d4e5f6')).toBe(true);
  });

  it('still refuses a fabrication that appears nowhere', async () => {
    await havingReadSomething('inv-1');
    await seedProvenanceFromContext({
      invocationId: 'inv-1',
      texts: ['please reply on thread 18c4f2a9b3d4e5f6 before noon'],
      structured: { integrations: [{ channel_id: 'C0FIXEDCHANNEL' }] },
    });
    expect(await check('inv-1', 'ffffffffffffffff')).toBe(false);
  });

  it('does not let a short value match prose by accident', async () => {
    // A false ACCEPT is worse than a false flag here: it waves through the
    // fabrication the gate exists to catch. Two characters appear in almost
    // any sentence.
    await havingReadSomething('inv-1');
    await seedProvenanceFromContext({ invocationId: 'inv-1', texts: ['reply to the thread about ab'] });
    expect(await check('inv-1', 'ab')).toBe(false);
  });

  it('does not leak given text between runs', async () => {
    await seedProvenanceFromContext({ invocationId: 'inv-1', texts: ['thread 18c4f2a9b3d4e5f6'] });
    await havingReadSomething('inv-2');
    expect(await check('inv-2', '18c4f2a9b3d4e5f6')).toBe(false);
  });
});
