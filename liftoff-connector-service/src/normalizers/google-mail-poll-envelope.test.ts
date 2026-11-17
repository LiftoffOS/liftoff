// Gmail's normalizer must speak the SCHEDULER's envelope, not only Gmail's.
//
// `pollEntityType` calls `normalizer.normalize({ results: records.map(r => r.data) })`.
// This normalizer knew only the raw Gmail API shapes — `messages`, `threads`,
// `history`, push notifications, single message/thread/label — so every
// predicate returned false for that envelope and `normalize` returned an empty
// array. Gmail polling published nothing for the life of the connector: no
// error, connector `active`, Connections page green, support mailbox unread.
//
// Two other defects on this same path produced the identical symptom and were
// each fixed believing they were the cause — an empty bearer token 401ing every
// poll, then a 33-second cursor window that outran Gmail's search indexing.
// This is the third, and it is the one that had always been there.

import { GoogleMailNormalizer } from './google-mail.normalizer';

const normalizer = new GoogleMailNormalizer();

describe("the scheduler's {results:[…]} envelope", () => {
  it('normalizes message refs the poller actually returns', () => {
    // Exactly what GoogleMailClient.list() yields: Gmail messages.list refs.
    const out = normalizer.normalize({
      results: [
        { id: 'a239502b68ecd7f7', threadId: 'a239502b68ecd7f7' },
        { id: '1a0077d790797e2b', threadId: 'a239502b68ecd7f7' },
      ],
    });

    expect(out).toHaveLength(2);
    expect(out[0].externalId).toBe('a239502b68ecd7f7');
    // threadId must survive: it is the field the runtime's event envelope
    // exposes as `input.message.threadId`, which is what every downstream
    // workflow step addresses.
    expect(out[0].data).toMatchObject({ threadId: 'a239502b68ecd7f7' });
  });

  it('returns one record per message, so nothing is silently coalesced', () => {
    const out = normalizer.normalize({ results: [{ id: 'a', threadId: 't' }] });
    expect(out).toHaveLength(1);
  });

  it('falls back to the message id when a ref carries no threadId', () => {
    // A ref without a thread is still addressable by its own id; dropping it
    // would reproduce the silence this test exists to prevent.
    const out = normalizer.normalize({ results: [{ id: 'solo' }] });
    expect(out).toHaveLength(1);
    expect(out[0].data).toMatchObject({ threadId: 'solo' });
  });

  it('skips a ref with no id rather than publishing an unaddressable event', () => {
    const out = normalizer.normalize({ results: [{ threadId: 't' }, { id: 'ok', threadId: 't' }] });
    expect(out).toHaveLength(1);
    expect(out[0].externalId).toBe('ok');
  });

  it('an empty result set normalizes to nothing, without throwing', () => {
    expect(normalizer.normalize({ results: [] })).toEqual([]);
  });
});

describe('the raw Gmail shapes still work', () => {
  it('still handles a messages.list response directly', () => {
    const out = normalizer.normalize({ messages: [{ id: 'm1', threadId: 't1' }] });
    expect(out).toHaveLength(1);
    expect(out[0].externalId).toBe('m1');
  });
});
