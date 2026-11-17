// Which conversation a Chief AI Officer thread was brought in from: the
// three pairing stores, asked in order, the first answer winning, and a
// miss when none has it.

const liftoff = jest.fn();
const insights = jest.fn();
const team = jest.fn();
jest.mock('../liftoff/chat-repository', () => ({ getDelegationByDelegateThread: (...a: unknown[]) => liftoff(...a) }));
jest.mock('../agent-chat/assistant-delegations', () => ({ getAssistantDelegationByDelegateThread: (...a: unknown[]) => insights(...a) }));
jest.mock('../agent-chat/colleague-request', () => ({ getTeamThreadByColleagueThread: (...a: unknown[]) => team(...a) }));

import { findHostByDelegateThread } from './source-host';

beforeEach(() => {
  jest.clearAllMocks();
  liftoff.mockResolvedValue(null);
  insights.mockResolvedValue(null);
  team.mockResolvedValue(null);
});

describe('findHostByDelegateThread', () => {
  it('a Liftoff pairing answers first and the other stores are not asked', async () => {
    liftoff.mockResolvedValue({ liftoffThreadId: 'lt', targetId: null });
    expect(await findHostByDelegateThread('t', 'd')).toEqual({ host: 'liftoff', threadId: 'lt' });
    expect(liftoff).toHaveBeenCalledWith('d', 'caio');
    expect(insights).not.toHaveBeenCalled();
    expect(team).not.toHaveBeenCalled();
  });

  it('then the Insights Manager pairing (495), under the tenant, for the caio target', async () => {
    insights.mockResolvedValue({ threadId: 'it' });
    expect(await findHostByDelegateThread('t', 'd')).toEqual({ host: 'insights', threadId: 'it' });
    expect(insights).toHaveBeenCalledWith('t', 'insights', 'caio', 'd');
    expect(team).not.toHaveBeenCalled();
  });

  it("then the team chat pairing (490), under the tenant, for the caio colleague", async () => {
    team.mockResolvedValue({ threadId: 'tt' });
    expect(await findHostByDelegateThread('t', 'd')).toEqual({ host: 'agent', threadId: 'tt' });
    expect(team).toHaveBeenCalledWith('t', 'caio', 'd');
  });

  it('a miss in every store is null', async () => {
    expect(await findHostByDelegateThread('t', 'd')).toBeNull();
    expect(liftoff).toHaveBeenCalledTimes(1);
    expect(insights).toHaveBeenCalledTimes(1);
    expect(team).toHaveBeenCalledTimes(1);
  });
});
