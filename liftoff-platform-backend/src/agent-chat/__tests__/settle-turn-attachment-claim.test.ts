// The settle backstop holds a reply to the same standard as the live path.
//
// A reply that reaches the thread through this callback — the tab was gone
// before the stream finished — is the only copy the person will ever read.
// If the live path checks attachment claims and this one does not, the
// correction depends on whether somebody kept a browser tab open, which is
// not a property a transcript should have. The same check runs on the same
// text, the same line lands in the same row, and the finding is logged only
// once the row is actually written.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import express from 'express';
import request from 'supertest';

const appendMessage = jest.fn();
const countFileCards = jest.fn();
const notifyReplyPersisted = jest.fn();
const logInfo = jest.fn();
const logWarn = jest.fn();

jest.mock('../chat-repository', () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  countFileCardsProducedInTurn: (...a: unknown[]) => countFileCards(...a),
}));
jest.mock('../out-of-turn-delivery', () => ({
  notifyReplyPersisted: (...a: unknown[]) => notifyReplyPersisted(...a),
}));
jest.mock('../../injection-detection/gating', () => ({
  screenPersistedContent: jest.fn().mockResolvedValue({ block: false }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: (...a: unknown[]) => logInfo(...a),
    warn: (...a: unknown[]) => logWarn(...a),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { settleTurnRouter } from '../settle-turn-router';
import { NO_FILE_ATTACHED } from '../attachment-claims';
import { RUN_PROGRESS_MESSAGE_TYPE } from '../run-progress';

const app = express();
app.use(settleTurnRouter);

const CLAIM = 'The signed NDA is attached below this message.';
const body = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  threadId: '22222222-2222-2222-2222-222222222222',
  agentId: '33333333-3333-3333-3333-333333333333',
  turnId: '44444444-4444-4444-4444-444444444444',
  invocationId: '55555555-5555-5555-5555-555555555555',
  replyText: CLAIM,
  final: true,
};

const post = (payload: Record<string, unknown>) =>
  request(app).post('/settle-turn').set('x-service-auth', 'test-token').send(payload);

/** The text the settle path asked appendMessage to persist. */
const persisted = () => appendMessage.mock.calls[0][3] as string;

beforeEach(() => {
  process.env.PLATFORM_CALLBACK_TOKEN = 'test-token';
  appendMessage.mockReset().mockResolvedValue({ id: 'msg-1' });
  countFileCards.mockReset();
  notifyReplyPersisted.mockReset();
  logInfo.mockReset();
  logWarn.mockReset();
});

describe('settle-turn holds the reply to its attachment claim', () => {
  it('appends the correction to the persisted row on a known turn with no cards, and logs the finding', async () => {
    countFileCards.mockResolvedValue({ attributed: 0, unattributed: 0 });

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
    expect(countFileCards).toHaveBeenCalledWith(body.tenantId, body.threadId, body.turnId);
    expect(persisted()).toBe(`${CLAIM}\n\n${NO_FILE_ATTACHED}`);
    // The row is keyed to the turn like the live path's, so the two cannot
    // both leave one.
    expect(appendMessage.mock.calls[0][11]).toBe(body.turnId);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'attachment_claim_unbacked',
        threadId: body.threadId,
        turnId: body.turnId,
        invocationId: body.invocationId,
      }),
      expect.any(String),
    );
  });

  it('pushes the text it persisted, correction included', async () => {
    countFileCards.mockResolvedValue({ attributed: 0, unattributed: 0 });
    await post(body);
    expect(notifyReplyPersisted).toHaveBeenCalledWith(
      expect.objectContaining({ text: `${CLAIM}\n\n${NO_FILE_ATTACHED}` }),
    );
  });

  it('persists a backed claim unchanged', async () => {
    countFileCards.mockResolvedValue({ attributed: 1, unattributed: 0 });
    await post(body);
    expect(persisted()).toBe(CLAIM);
    expect(logWarn).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('persists unchanged and logs the skip when the lookup throws', async () => {
    countFileCards.mockRejectedValue(new Error('timeout'));
    await post(body);
    expect(persisted()).toBe(CLAIM);
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'attachment_claim_check_skipped', reason: 'lookup_failed', invocationId: body.invocationId }),
      expect.any(String),
    );
  });

  it('cites a null invocation id when an older runtime image sent none', async () => {
    countFileCards.mockResolvedValue({ attributed: 0, unattributed: 0 });
    const { invocationId: _omit, ...withoutInvocation } = body;
    void _omit;
    await post(withoutInvocation);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'attachment_claim_unbacked', invocationId: null }),
      expect.any(String),
    );
  });

  it('logs nothing when the live path had already persisted the turn — the lost writer has no row to describe', async () => {
    countFileCards.mockResolvedValue({ attributed: 0, unattributed: 0 });
    appendMessage.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body.alreadyPersisted).toBe(true);
    expect(logWarn).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('does not check a settle that does not say it is final — the partial a paused turn settles, or an older runtime image', async () => {
    // A paused turn's partial stops mid-work, often on the very tool that
    // will produce the card, and the card lands under the continuation. An
    // older image marks nothing, and is read the same way.
    const { final: _omit, ...notFinal } = body;
    void _omit;
    await post(notFinal);
    expect(countFileCards).not.toHaveBeenCalled();
    expect(persisted()).toBe(CLAIM);
    expect(logWarn).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('does not check narration about a run — it is not the team speaking', async () => {
    await post({ ...body, replyText: 'Still working; the deck is attached below when it lands.', messageType: RUN_PROGRESS_MESSAGE_TYPE });
    expect(countFileCards).not.toHaveBeenCalled();
    expect(persisted()).toBe('Still working; the deck is attached below when it lands.');
  });

  it('does not look when the reply makes no claim', async () => {
    await post({ ...body, replyText: 'I attached a note to the CRM record.' });
    expect(countFileCards).not.toHaveBeenCalled();
    expect(persisted()).toBe('I attached a note to the CRM record.');
  });
});
