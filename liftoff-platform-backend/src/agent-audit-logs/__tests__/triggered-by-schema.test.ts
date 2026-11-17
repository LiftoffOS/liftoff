// SE-007 triggeredBy format contract.
//
// The router's zod `triggeredBySchema` is the single gate for every audit row
// the runtime posts; a value it rejects is 400'd, retried by the outbox, then
// dropped. Regression coverage for the observed prod drop where Slack-attributed
// invocation audits (triggeredBy `human:slack:<uid>`) were silently discarded
// because the human suffix forbade the `:` namespace separator.

jest.mock('../../infrastructure/database', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../infrastructure/logging');

import { triggeredBySchema } from '../router';

const ok = (v: string) => triggeredBySchema.safeParse(v).success;

describe('SE-007 triggeredBy format contract', () => {
  it('accepts provider-namespaced human ids (regression: human:slack:<uid> was dropped)', () => {
    expect(ok('human:slack:C01ABCD2EFG')).toBe(true);
    expect(ok('human:slack.workspace-1:C01ABCD2EFG')).toBe(true);
    expect(ok('human:google:117240750432')).toBe(true);
  });

  it('still accepts every previously-valid form', () => {
    for (const v of [
      'human:123e4567-e89b-12d3-a456-426614174000',
      'human:aBcD1234567890aBcD1234567890', // Firebase UID
      'agent',
      'agent:1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
      'cron',
      'event:gmail.new_message',
      'event:tenant.oversight.updated',
      'system',
      'system:hybrid_loop',
      'system:reconciler.poll',
    ]) {
      expect(ok(v)).toBe(true);
    }
  });

  it('still rejects unattributed / malformed forms (no silent widening)', () => {
    for (const v of [
      'event',          // bare event still needs a topic
      'human',          // bare human still needs an id
      'human:',         // empty suffix
      'random',         // unknown base
      'event:bad topic',// whitespace not allowed
      'human:jane@x.com', // '@' deliberately not permitted
      '',
    ]) {
      expect(ok(v)).toBe(false);
    }
  });
});
