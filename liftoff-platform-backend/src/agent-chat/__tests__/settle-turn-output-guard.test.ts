// The settle callback is the other place a team's reply becomes a row, so
// it reads the reply the way the live stream does before persisting it. A
// run's own narration (`run_progress`) is the runtime's sentence and is not
// read.

import express from 'express';
import request from 'supertest';

const appendMessage = jest.fn();
const mockGuard = jest.fn();

jest.mock('../chat-repository', () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  countFileCardsProducedInTurn: jest.fn().mockResolvedValue({ attributed: 1, unattributed: 0 }),
}));
jest.mock('../out-of-turn-delivery', () => ({
  notifyReplyPersisted: jest.fn(),
}));
jest.mock('../../injection-detection/gating', () => ({
  screenPersistedContent: jest.fn().mockResolvedValue({ block: false }),
}));
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: (...args: unknown[]) => mockGuard(...args),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { settleTurnRouter } from '../settle-turn-router';
import { RUN_PROGRESS_MESSAGE_TYPE } from '../run-progress';

const app = express();
app.use(settleTurnRouter);

const ID = '122662dd-de4e-4b0d-8873-50cd6a00daaf';
const body = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  threadId: '22222222-2222-2222-2222-222222222222',
  agentId: '33333333-3333-3333-3333-333333333333',
  turnId: '44444444-4444-4444-4444-444444444444',
};

const post = (payload: Record<string, unknown>) =>
  request(app).post('/settle-turn').set('x-service-auth', 'test-token').send(payload);

beforeEach(() => {
  process.env.PLATFORM_CALLBACK_TOKEN = 'test-token';
  appendMessage.mockReset().mockResolvedValue({ id: 'msg-1' });
  mockGuard.mockReset().mockImplementation(async (text: string) =>
    text.includes('per the request')
      ? { text: text.replace(', per the request', ''), changed: true, kinds: ['mechanics'] }
      : { text, changed: false, kinds: [] });
});

describe('settle-turn reads the reply before persisting it', () => {
  it('persists the guarded text, scrubbed of the id', async () => {
    const res = await post({ ...body, replyText: `Merged the pull request (id ${ID}), per the request.`, final: true });

    expect(res.status).toBe(200);
    expect(appendMessage.mock.calls[0][3]).toBe('Merged the pull request.');
    expect(mockGuard).toHaveBeenCalledWith(
      'Merged the pull request, per the request.',
      { tenantId: body.tenantId, speaker: body.agentId, threadId: body.threadId },
    );
  });

  it('does not read a run\'s own narration', async () => {
    const detail = 'This run is still working and will deliver here when it lands.';
    const res = await post({ ...body, replyText: detail, messageType: RUN_PROGRESS_MESSAGE_TYPE });

    expect(res.status).toBe(200);
    expect(appendMessage.mock.calls[0][3]).toBe(detail);
    expect(mockGuard).not.toHaveBeenCalled();
  });
});
