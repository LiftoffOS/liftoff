// The one value both of a run's audit rows carry.

jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
  withTenantScope: jest.fn(),
}));

import { resolveStartTriggeredBy } from '../trigger-attribution';
import { conformTriggeredBy } from '../../audit/service';

const AGENT = 'aaaaaaaa-1111-2222-3333-444444444444';
const HUMAN = 'bbbbbbbb-1111-2222-3333-444444444444';

describe('resolveStartTriggeredBy', () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof resolveStartTriggeredBy>[0];
    expected: string;
  }> = [
    {
      name: 'cron stays bare',
      input: { triggeredBy: 'cron', agentId: AGENT },
      expected: 'cron',
    },
    {
      name: 'no trigger at all defaults to cron',
      input: { agentId: AGENT },
      expected: 'cron',
    },
    {
      name: 'agent carries WHICH agent',
      input: { triggeredBy: 'agent', agentId: AGENT },
      expected: `agent:${AGENT}`,
    },
    {
      name: 'event carries the label-derived topic',
      input: { triggeredBy: 'event', agentId: AGENT, triggeredByLabel: 'reactive:deal-won' },
      // The label's ':' is the '.' hierarchy separator in an event topic.
      expected: 'event:reactive.deal-won',
    },
    {
      name: 'event with no label keeps the generic topic',
      input: { triggeredBy: 'event', agentId: AGENT },
      expected: 'event:scheduled',
    },
    {
      name: 'human with a human carries the human',
      input: { triggeredBy: 'human', agentId: AGENT, triggeredByUserId: HUMAN },
      expected: `human:${HUMAN}`,
    },
    {
      name: 'human with a namespaced channel id keeps the namespace',
      input: { triggeredBy: 'human', agentId: AGENT, triggeredByUserId: 'slack:C01ABCD2EFG' },
      expected: 'human:slack:C01ABCD2EFG',
    },
    {
      name: 'human with NO human is the platform, not a person',
      input: { triggeredBy: 'human', agentId: AGENT },
      expected: 'system:agent_execution',
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(resolveStartTriggeredBy(input)).toBe(expected);
  });

  // The defect this replaces: a human trigger with no user id put the AGENT's
  // own uuid in the human: slot, so the Activity page showed a person who does
  // not exist.
  it('never puts the agent id in the human: slot', () => {
    for (const { input } of cases) {
      const out = resolveStartTriggeredBy(input);
      if (out.startsWith('human:')) {
        expect(out).not.toContain(input.agentId);
      }
    }
  });

  // Everything we emit must already satisfy the control plane's SE-007 grammar,
  // so the outbox's coercion path never rewrites one of our own values (that is
  // how 'human'/'event' became human:unknown / event:unknown).
  it('emits only values conformTriggeredBy leaves untouched', () => {
    for (const { input } of cases) {
      const out = resolveStartTriggeredBy(input);
      expect(conformTriggeredBy(out)).toBe(out);
    }
  });

  it('degrades a non-uuid agent id to bare agent rather than an invalid value', () => {
    const out = resolveStartTriggeredBy({ triggeredBy: 'agent', agentId: 'NOT A UUID' });
    expect(out).toBe('agent');
    expect(conformTriggeredBy(out)).toBe(out);
  });

  it('strips a label that would break the event topic grammar', () => {
    const out = resolveStartTriggeredBy({
      triggeredBy: 'event',
      agentId: AGENT,
      triggeredByLabel: 'computed_metric:spend/day',
    });
    expect(conformTriggeredBy(out)).toBe(out);
    expect(out.startsWith('event:')).toBe(true);
  });
});
