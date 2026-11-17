// Carrying a resumed team reply back into the Liftoff conversation that asked
// for it.
//
// The team's own thread is written by the caller and is not this module's
// business; everything here is about the copy: whether one is owed, who it is
// attributed to, and what happens when any part of that cannot be resolved. None
// of it may ever throw, because every caller is a settlement path that has
// already delivered the answer.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

jest.mock('../chat-repository', () => ({
  appendMessage: jest.fn(),
  createTurn: jest.fn(),
  getDelegationByDelegateThread: jest.fn(),
}));

jest.mock('../../internal-agents/service', () => ({
  internalAgentService: { getById: jest.fn() },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { appendMessage, getDelegationByDelegateThread } from '../chat-repository';
import { internalAgentService } from '../../internal-agents/service';
import { mirrorDelegatedReplyToLiftoff } from '../delegated-continuation';

const mockAppendMessage = appendMessage as jest.Mock;
const mockGetDelegation = getDelegationByDelegateThread as jest.Mock;
const mockGetById = internalAgentService.getById as jest.Mock;

const TENANT = 'tenant-1';
const DELEGATE_THREAD = 'delegate-thread-1';
const TEAM = 'agent-7';

const input = {
  tenantId: TENANT,
  delegateThreadId: DELEGATE_THREAD,
  replyText: 'The refund has been issued.',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDelegation.mockResolvedValue({ liftoffThreadId: 'thread-1', targetId: TEAM });
  mockGetById.mockResolvedValue({ id: TEAM, role: 'Support Team', status: 'active' });
  mockAppendMessage.mockResolvedValue({ id: 'mirrored-1' });
});

describe('mirrorDelegatedReplyToLiftoff', () => {
  it('writes the reply into the paired conversation, attributed to the team', async () => {
    await mirrorDelegatedReplyToLiftoff(input);

    expect(mockGetDelegation).toHaveBeenCalledWith(DELEGATE_THREAD, 'team');
    expect(mockAppendMessage).toHaveBeenCalledWith({
      threadId: 'thread-1',
      role: 'assistant',
      content: 'The refund has been issued.',
      author: TEAM,
      authorLabel: 'Support Team',
    });
  });

  // Which is nearly every thread: most people talk to their team directly.
  it('does nothing for a thread no Liftoff conversation is paired with', async () => {
    mockGetDelegation.mockResolvedValue(null);

    const result = await mirrorDelegatedReplyToLiftoff(input);

    expect(result).toBeNull();
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  // An answer somebody has been waiting hours for is worth more than the name on
  // it, and a team can legitimately have been paused while the approval sat.
  it('still delivers the reply when the team cannot be named', async () => {
    mockGetById.mockRejectedValue(new Error('lookup failed'));

    await mirrorDelegatedReplyToLiftoff(input);

    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ author: TEAM, authorLabel: null }),
    );
  });

  // The caller has already delivered the reply to the team's thread and settled
  // the run. A failed copy must not undo either.
  it('never throws when the copy cannot be written', async () => {
    mockAppendMessage.mockRejectedValue(new Error('write failed'));

    await expect(mirrorDelegatedReplyToLiftoff(input)).resolves.toBeNull();
  });

  // Only teams pause. Looking the pairing up by kind is what stops a thread id
  // from another colleague's surface resolving here by coincidence.
  it('only ever looks for a team pairing', async () => {
    await mirrorDelegatedReplyToLiftoff(input);

    expect(mockGetDelegation).toHaveBeenCalledTimes(1);
    expect(mockGetDelegation.mock.calls[0][1]).toBe('team');
  });
});
