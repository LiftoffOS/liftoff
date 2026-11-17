// The message check (message-check.ts): the entry conditions, what each
// setting does with the answer, the two-band invariant, completeness as a
// precondition of clearing, merge-to-main never asked, and the bounds and
// sanitisation on what it sends.

const mockAsk = jest.fn();
jest.mock('../../typesafe/client', () => ({ ask: (...a: unknown[]) => mockAsk(...a) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { logger } from '../../infrastructure/logging';
import { checkMessage, outgoingMessageOf, audienceOf, tickedKeysOf, type MessageCheckInput } from '../message-check';
import { oversightDecisionFor } from '../oversight-decision';
import { MESSAGE_CHECK_NOULS, MESSAGE_STATE_BYTES } from '../../typesafe/questions';
import type { OversightSettings } from '../../hitl-enforcement/types';

const oversight = (communication: OversightSettings['communication'], sensitiveWork: OversightSettings['sensitiveWork'], communicationSemantics = 2): OversightSettings => ({
  tenantId: 't1', autonomy: 'balanced', escalation: 'important', communication, sensitiveWork, communicationSemantics,
});
const email = { to: 'jane@acme.test', subject: 'Your order', body: 'Your order 4412 shipped today.' };

function input(over: Partial<MessageCheckInput> & { oversight: OversightSettings }): MessageCheckInput {
  const categories = over.categories ?? ['customerCommunication'];
  return {
    toolName: 'gmail-1__send_email',
    categories,
    args: email,
    decision: oversightDecisionFor({ categories }, over.oversight),
    contract: { kind: 'instructions', instructions: 'Answer support tickets.', role: 'You are the Support Representative.' },
    tenantId: 't1', agentId: 'ra-1', invocationId: 'inv-1',
    ...over,
  };
}

function reply(values: Record<string, number>) {
  const answers: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(values)) answers[MESSAGE_CHECK_NOULS[key].noul] = { noul: p };
  return { answers, model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'c1', attempts: 1, latencyMs: 4 };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TR_MESSAGE_CHECK_ENABLED;
  mockAsk.mockResolvedValue(reply({ customerCommunication: 0.02 }));
});

describe('entry conditions', () => {
  it('a non-outbound tool → no call', async () => {
    const out = await checkMessage(input({ oversight: oversight('auto', { dataChanges: true }), categories: ['dataChanges'] }));
    expect(out).toEqual({ kind: 'as_today' });
    expect(mockAsk).not.toHaveBeenCalled();
  });
  it('Draft first → no call', async () => {
    expect(await checkMessage(input({ oversight: oversight('draft', { customerCommunication: true }) }))).toEqual({ kind: 'as_today' });
    expect(mockAsk).not.toHaveBeenCalled();
  });
  it('Review with no category match → no call', async () => {
    expect(await checkMessage(input({ oversight: oversight('review', { hiringDecisions: true }) }))).toEqual({ kind: 'as_today' });
    expect(mockAsk).not.toHaveBeenCalled();
  });
  it('Auto with nothing ticked → no call', async () => {
    expect(await checkMessage(input({ oversight: oversight('auto', {}) }))).toEqual({ kind: 'as_today' });
    expect(mockAsk).not.toHaveBeenCalled();
  });
  it('the kill → no call', async () => {
    process.env.TR_MESSAGE_CHECK_ENABLED = '0';
    expect(await checkMessage(input({ oversight: oversight('auto', { customerCommunication: true }) }))).toEqual({ kind: 'as_today' });
    expect(mockAsk).not.toHaveBeenCalled();
  });
  it('merge-to-main is never asked; only the keys the table names are', () => {
    expect(tickedKeysOf(oversight('auto', { mergeToMain: true, customerCommunication: true, financialActions: true }))).toEqual(['financialActions', 'customerCommunication']);
    expect(Object.keys(MESSAGE_CHECK_NOULS)).not.toContain('mergeToMain');
  });
});

describe('Send automatically when safe (auto)', () => {
  const o = oversight('auto', { customerCommunication: true, financialActions: true });
  it('any Noul at or above UNSAFE_T → pause with reason sensitive_work and the category named', async () => {
    mockAsk.mockResolvedValue(reply({ customerCommunication: 0.2, financialActions: 0.85 }));
    const out = await checkMessage(input({ oversight: o }));
    expect(out).toEqual({
      kind: 'pause', reason: 'sensitive_work', matchedCategory: 'financialActions',
      context: { messageCheck: { setting: 'auto', asked: { customerCommunication: 0.2, financialActions: 0.85 }, model: 'jev-1.13.0', latencyMs: 4 } },
    });
  });
  it('every answer below the band → sends, with the verdict recorded', async () => {
    mockAsk.mockResolvedValue(reply({ customerCommunication: 0.3, financialActions: 0.69 }));
    const out = await checkMessage(input({ oversight: o }));
    expect(out).toEqual({ kind: 'as_today', context: { messageCheck: { setting: 'auto', asked: { customerCommunication: 0.3, financialActions: 0.69 }, model: 'jev-1.13.0', latencyMs: 4 } } });
  });
  it('null → sends, as today', async () => {
    mockAsk.mockResolvedValue(null);
    expect(await checkMessage(input({ oversight: o }))).toEqual({ kind: 'as_today' });
  });
  it('one call per outbound message: the set carries one Noul per ticked key, keyed by the setting', async () => {
    await checkMessage(input({ oversight: o }));
    const [set, state, opts] = mockAsk.mock.calls[0] as [{ id: string; questions: Record<string, unknown>; thresholds: Record<string, number> }, Record<string, unknown>, Record<string, unknown>];
    expect(set.id).toBe('message_check');
    expect(Object.keys(set.questions)).toEqual(['financial_actions', 'customer_communication']);
    expect(set.thresholds).toEqual({ UNSAFE_T: 0.7, CLEAR_T: 0.15 });
    expect(state).toEqual({
      message: { tool: 'gmail-1__send_email', content: { body: 'Your order 4412 shipped today.', subject: 'Your order' }, destination: { recipients: 'jane@acme.test' } },
      audience: 'external',
      ticked: ['financialActions', 'customerCommunication'],
      contract: { kind: 'instructions', instructions: 'Answer support tickets.', role: 'You are the Support Representative.' },
    });
    expect(opts).toEqual({ deadlineMs: 30_000, tenantId: 't1', runtimeAgentId: 'ra-1', invocationId: 'inv-1' });
  });
});

describe('Review for sensitive cases (review)', () => {
  const o = oversight('review', { customerCommunication: true, financialActions: true });
  it('all at or below CLEAR_T on a complete state with communicationSemantics >= 2 → sends, with the audit line', async () => {
    mockAsk.mockResolvedValue(reply({ customerCommunication: 0.15, financialActions: 0.03 }));
    const out = await checkMessage(input({ oversight: o }));
    expect(out).toEqual({ kind: 'send', context: { messageCheck: { setting: 'review', asked: { customerCommunication: 0.15, financialActions: 0.03 }, model: 'jev-1.13.0', latencyMs: 4 } } });
    const line = (logger.info as jest.Mock).mock.calls.find((c) => (c[0] as { event?: string }).event === 'hitl.gate.message_cleared');
    expect(line?.[0]).toMatchObject({ setting: 'review', asked: { customerCommunication: 0.15, financialActions: 0.03 }, model: 'jev-1.13.0', latencyMs: 4, tool_name: 'gmail-1__send_email' });
  });
  it('any answer above CLEAR_T → pauses, as today, with the verdict recorded', async () => {
    mockAsk.mockResolvedValue(reply({ customerCommunication: 0.16, financialActions: 0.0 }));
    expect(await checkMessage(input({ oversight: o }))).toEqual({ kind: 'as_today', context: { messageCheck: { setting: 'review', asked: { customerCommunication: 0.16, financialActions: 0 }, model: 'jev-1.13.0', latencyMs: 4 } } });
  });
  it('a missing answer → pauses', async () => {
    mockAsk.mockResolvedValue(reply({ customerCommunication: 0.0 }));
    expect((await checkMessage(input({ oversight: o }))).kind).toBe('as_today');
  });
  it('null → pauses', async () => {
    mockAsk.mockResolvedValue(null);
    expect(await checkMessage(input({ oversight: o }))).toEqual({ kind: 'as_today' });
  });
  it('communicationSemantics 1 (or absent) → pauses even when every answer is clear', async () => {
    mockAsk.mockResolvedValue(reply({ customerCommunication: 0.0, financialActions: 0.0 }));
    expect((await checkMessage(input({ oversight: oversight('review', { customerCommunication: true, financialActions: true }, 1) }))).kind).toBe('as_today');
    const absent = { ...o } as OversightSettings;
    delete absent.communicationSemantics;
    expect((await checkMessage(input({ oversight: absent }))).kind).toBe('as_today');
  });
});

describe('the two bands', () => {
  it('no answer set both pauses under Auto and clears under Review', async () => {
    const auto = oversight('auto', { customerCommunication: true });
    const review = oversight('review', { customerCommunication: true });
    for (const p of [0, 0.05, 0.15, 0.16, 0.3, 0.5, 0.69, 0.7, 0.9, 1]) {
      mockAsk.mockResolvedValue(reply({ customerCommunication: p }));
      const a = await checkMessage(input({ oversight: auto }));
      const r = await checkMessage(input({ oversight: review }));
      expect(a.kind === 'pause' && r.kind === 'send').toBe(false);
      if (p >= 0.7) expect(a.kind).toBe('pause');
      if (p <= 0.15) expect(r.kind).toBe('send');
      if (p > 0.15 && p < 0.7) { expect(a.kind).toBe('as_today'); expect(r.kind).toBe('as_today'); }
    }
  });
});

describe('completeness', () => {
  it('a message with no body field: under Review pauses with context.messageCheck.incomplete, under Auto sends; no call either way', async () => {
    const args = { to: 'jane@acme.test', subject: 'no body here' };
    const r = await checkMessage(input({ oversight: oversight('review', { customerCommunication: true }), args }));
    expect(r).toEqual({ kind: 'as_today', context: { messageCheck: { setting: 'review', asked: {}, incomplete: true } } });
    const a = await checkMessage(input({ oversight: oversight('auto', { customerCommunication: true }), args }));
    expect(a).toEqual({ kind: 'as_today', context: { messageCheck: { setting: 'auto', asked: {}, incomplete: true } } });
    expect(mockAsk).not.toHaveBeenCalled();
    expect((logger.warn as jest.Mock).mock.calls.filter((c) => (c[0] as { metric?: string }).metric === 'message_check.incomplete')).toHaveLength(2);
  });
  it('a state over MESSAGE_STATE_BYTES is incomplete: nothing is cut', async () => {
    const args = { ...email, body: 'x'.repeat(MESSAGE_STATE_BYTES + 100) };
    const r = await checkMessage(input({ oversight: oversight('review', { customerCommunication: true }), args }));
    expect(r).toMatchObject({ kind: 'as_today', context: { messageCheck: { incomplete: true } } });
    expect(mockAsk).not.toHaveBeenCalled();
  });
});

describe('the outgoing message', () => {
  it('resolves body, subject, attachment names and the destination across the families; secrets redacted; nothing else cut', () => {
    const m = outgoingMessageOf({
      to: ['a@x.test', 'b@x.test'], cc: 'c@x.test', subject: 'Hello', body: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789 and ' + 'y'.repeat(5_000),
      attachments: [{ name: 'invoice.pdf', content: 'ZmFrZQ==' }, 'photo.png'],
      channel: 'C123', thread_ts: '1.2', url: 'https://x.test/p/1',
    });
    expect(m.complete).toBe(true);
    expect(m.content.subject).toBe('Hello');
    expect(m.content.body as string).toContain('Bearer [REDACTED]');
    expect((m.content.body as string).length).toBeGreaterThan(5_000);
    expect(m.content.attachments).toEqual(['invoice.pdf', 'photo.png']);
    expect(JSON.stringify(m)).not.toContain('ZmFrZQ==');
    expect(m.destination).toEqual({ recipients: ['a@x.test', 'b@x.test', 'c@x.test'], channel: 'C123', thread: '1.2', url: 'https://x.test/p/1' });
    expect(outgoingMessageOf({ channel: 'C1', text: 'hi' }).content).toEqual({ body: 'hi' });
    expect(outgoingMessageOf({ message: { text: 'nested' } }).content).toEqual({ body: { text: 'nested' } });
    expect(outgoingMessageOf({ to: 'x' }).complete).toBe(false);
  });
  it('audience from the categories', () => {
    expect(audienceOf(['customerCommunication'])).toBe('external');
    expect(audienceOf(['outbound', 'externalPublishing'])).toBe('external');
    expect(audienceOf(['internalCollaboration'])).toBe('internal');
    expect(audienceOf(['outbound'])).toBe('unknown');
  });
});
