/**
 * Every set id the runtime asks under is one this side accepts.
 *
 * The two lists are separate copies in separate repos, and the failure when
 * they disagree is silent in the worst way: the usage post 400s, `ask` returns
 * null, and the caller falls back forever with nothing saying so. The
 * `untrusted_content` comment in questions.ts records that trap; this makes it
 * a check rather than a warning somebody has to remember.
 *
 * Asserted as a FROZEN SET rather than by reaching into the other repo, which
 * this test cannot see. Adding an id here without adding it there still ships a
 * classifier that never runs — but the two changes now have to be made in one
 * deliberate act, and the list below names what the runtime expects.
 */
import { RUNTIME_SET_IDS } from '../questions';
import { purposeFor } from '../../internal-api/usage-record-router';

/** What the tenant runtime sends `setId` as. Keep in step with its own
 *  `RUNTIME_SET_IDS`; a removal here is as breaking as an addition there. */
const RUNTIME_EXPECTS = [
  'browser_step',
  'browser_goal_check',
  'pane_target',
  'work_done_check',
  'file_check',
  'contract_check',
  'ask_check',
  'memory_save',
  'memory_used',
  'message_check',
  'untrusted_content',
  'run_now_intent',
] as const;

describe('the control plane accepts every set the runtime asks under', () => {
  it.each(RUNTIME_EXPECTS)('accepts %s', (setId) => {
    expect((RUNTIME_SET_IDS as readonly string[])).toContain(setId);
  });

  it.each(RUNTIME_EXPECTS)('gives %s a purpose, so its cost is not "other"', (setId) => {
    // A set the route accepts but nothing maps lands in the unnamed bucket on
    // the Insights page. Accepting an id and not naming it is half a landing.
    const got = purposeFor({ provider: 'typesafe', setId });
    expect(got).not.toHaveProperty('error');
  });

  it('refuses an id neither side declares', () => {
    const got = purposeFor({ provider: 'typesafe', setId: 'not_a_real_set' });
    expect(got).toHaveProperty('error');
  });
});
