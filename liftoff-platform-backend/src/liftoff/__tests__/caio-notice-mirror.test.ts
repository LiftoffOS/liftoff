// Carrying a CAIO provisioning notice into the Liftoff conversation.
//
// A Liftoff thread that brings the CAIO in is paired with a team-plan thread,
// and the person reads only the Liftoff one. Provisioning finishes minutes after
// that turn ended, so a notice written to the team-plan thread alone is filed
// somewhere they have never opened.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../internal-agents/service', () => ({
  internalAgentService: { getById: jest.fn() },
}));

const mockAppendMessage = jest.fn();
const mockGetDelegation = jest.fn();
const mockGetThread = jest.fn();
jest.mock('../chat-repository', () => ({
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
  getDelegationByDelegateThread: (...a: unknown[]) => mockGetDelegation(...a),
  getThread: (...a: unknown[]) => mockGetThread(...a),
}));

import { mirrorCAIONoticeToLiftoff } from '../delegated-continuation';
import { CAIO_DELEGATION_TARGET } from '../delegation-targets';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const CAIO_THREAD = 'f411a323-d2d2-4984-a4f6-e5b45a232a04';
const LIFTOFF_THREAD = '1f6c871a-af0a-4831-af24-ce25b3528853';
const CONTENT = 'Lead Research is set up. It is on the Teams page in draft status.';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDelegation.mockResolvedValue({ liftoffThreadId: LIFTOFF_THREAD, targetId: 'caio' });
  mockGetThread.mockResolvedValue({ id: LIFTOFF_THREAD, tenantId: TENANT });
  mockAppendMessage.mockResolvedValue({ id: 'm1' });
});

describe('mirrorCAIONoticeToLiftoff', () => {
  it('looks the pairing up on the caio kind, not team', async () => {
    // The three colleague surfaces keep their thread ids in three different
    // tables, so the kind is what stops a team-plan id resolving as a team's.
    await mirrorCAIONoticeToLiftoff({
      tenantId: TENANT,
      delegateThreadId: CAIO_THREAD,
      content: CONTENT,
    });

    expect(mockGetDelegation).toHaveBeenCalledWith(CAIO_THREAD, 'caio');
  });

  it('attributes the copy exactly as the live delegation does', async () => {
    // A notice arriving ten minutes late must not render as a second colleague.
    await mirrorCAIONoticeToLiftoff({
      tenantId: TENANT,
      delegateThreadId: CAIO_THREAD,
      content: CONTENT,
    });

    expect(mockAppendMessage).toHaveBeenCalledWith({
      threadId: LIFTOFF_THREAD,
      role: 'assistant',
      content: CONTENT,
      author: CAIO_DELEGATION_TARGET.id,
      authorLabel: CAIO_DELEGATION_TARGET.label,
    });
    expect(CAIO_DELEGATION_TARGET.id).toBe('caio');
    expect(CAIO_DELEGATION_TARGET.label).toBe('Chief AI Officer');
  });

  it('returns null and writes nothing when the thread is not paired', async () => {
    // The ordinary case: someone using the CAIO surface directly has already
    // been told in the thread they are reading.
    mockGetDelegation.mockResolvedValue(null);

    const result = await mirrorCAIONoticeToLiftoff({
      tenantId: TENANT,
      delegateThreadId: CAIO_THREAD,
      content: CONTENT,
    });

    expect(result).toBeNull();
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('refuses to write when the paired thread is not that tenant\'s', async () => {
    // The tenant id arrives in an internal request body, and the delegation
    // table is not keyed by tenant. Without this check a wrong or forged id
    // would write into another workspace's conversation.
    mockGetThread.mockResolvedValue(null);

    const result = await mirrorCAIONoticeToLiftoff({
      tenantId: TENANT,
      delegateThreadId: CAIO_THREAD,
      content: CONTENT,
    });

    expect(result).toBeNull();
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('checks the thread against the tenant that was claimed', async () => {
    await mirrorCAIONoticeToLiftoff({
      tenantId: TENANT,
      delegateThreadId: CAIO_THREAD,
      content: CONTENT,
    });

    expect(mockGetThread).toHaveBeenCalledWith(LIFTOFF_THREAD, TENANT);
  });

  it('never throws, so a failed copy cannot cost the notice', async () => {
    mockAppendMessage.mockRejectedValue(new Error('db down'));

    await expect(
      mirrorCAIONoticeToLiftoff({
        tenantId: TENANT,
        delegateThreadId: CAIO_THREAD,
        content: CONTENT,
      }),
    ).resolves.toBeNull();
  });

  it('claims no token spend for a notice composed in code', async () => {
    await mirrorCAIONoticeToLiftoff({
      tenantId: TENANT,
      delegateThreadId: CAIO_THREAD,
      content: CONTENT,
    });

    const call = mockAppendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('inputTokens');
    expect(call).not.toHaveProperty('outputTokens');
  });
});
