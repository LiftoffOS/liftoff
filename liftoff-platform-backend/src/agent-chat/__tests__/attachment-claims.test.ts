// Which replies claim a file is attached to them, and what the check does
// about it.
//
// The corpus is real: the three replies are what the NDA analyst wrote on
// three consecutive dev turns on which no `file_output` row existed. The
// negatives are the phrases the matcher must NOT fire on — a reply that says
// it attached something to a record, or that merely names an attachment the
// person sent, is not claiming a card under itself.
//
// The check has exactly one positive outcome, and every other row of its
// decision table is a skip with a reason. Each row is pinned here, and so is
// the split between deciding and logging: the verdict is computed before the
// row is written, the finding is recorded only after it lands. The
// persisted-row proof (the line survives chat-service's choice of reply text,
// and the settle backstop writes the same line) lives in
// attachment-claim-persistence.test.ts and settle-turn-attachment-claim.test.ts.

const mockCount = jest.fn();
const logInfo = jest.fn();
const logWarn = jest.fn();

jest.mock('../chat-repository', () => ({
  countFileCardsProducedInTurn: (...args: unknown[]) => mockCount(...args),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: (...args: unknown[]) => logInfo(...args),
    warn: (...args: unknown[]) => logWarn(...args),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  checkAttachmentClaim,
  claimsAttachment,
  NO_FILE_ATTACHED,
  recordAttachmentClaimFinding,
} from '../attachment-claims';

describe('claimsAttachment', () => {
  it.each([
    // The three traced replies.
    'The NDA is delivered to you here as a downloadable attachment (the card under this message).',
    'The signed NDA is attached below this message.',
    'Attached below.',
    // Whole phrases, any casing.
    'You will find the deck ATTACHED HERE.',
    'The revised contract is attached to this message for your review.',
    'The deck is attached to this conversation.',
    'It is included as an attachment.',
    'See the file card below.',
    'Open the card under this reply to download it.',
  ])('fires on: %s', (text) => {
    expect(claimsAttachment(text)).toBe(true);
  });

  it.each([
    // A claim about a record, not about this message.
    'I attached a note to the CRM record.',
    'I attached the PDF to the ticket in Zendesk.',
    // Naming what the person sent.
    'Thanks for the attachment; I have read the contract you sent.',
    'The attachment you shared is 14 pages.',
    // Plain prose that happens to share words.
    'The card was declined by the bank.',
    'Below are the three findings.',
    'Here is the summary you asked for.',
    'No strings attached.',
    '',
  ])('does not fire on: %s', (text) => {
    expect(claimsAttachment(text)).toBe(false);
  });
});

describe('NO_FILE_ATTACHED', () => {
  it('says nothing about a link, because the reply may not contain one', () => {
    expect(NO_FILE_ATTACHED).toBe('No file was attached to this message.');
    expect(NO_FILE_ATTACHED).not.toMatch(/link|url/i);
  });

  it('keeps the product voice', () => {
    expect(NO_FILE_ATTACHED).not.toMatch(/—|'|agent/);
  });
});

describe('checkAttachmentClaim', () => {
  const base = { tenantId: 'tenant-1', threadId: 'thread-1', turnId: 'turn-1' };
  const CLAIM = 'The signed NDA is attached below this message.';

  beforeEach(() => {
    mockCount.mockReset();
    logInfo.mockReset();
    logWarn.mockReset();
  });

  it('appends the correction on a known turn with zero attributed and zero unattributed cards', async () => {
    mockCount.mockResolvedValue({ attributed: 0, unattributed: 0 });
    const verdict = await checkAttachmentClaim({ ...base, text: CLAIM });
    expect(verdict).toEqual({ text: `${CLAIM}\n\n${NO_FILE_ATTACHED}`, finding: { kind: 'unbacked' } });
    expect(mockCount).toHaveBeenCalledWith('tenant-1', 'thread-1', 'turn-1');
  });

  it('leaves a backed claim alone — one card attributed to the turn', async () => {
    mockCount.mockResolvedValue({ attributed: 1, unattributed: 0 });
    expect(await checkAttachmentClaim({ ...base, text: CLAIM })).toEqual({ text: CLAIM, finding: { kind: 'backed' } });
  });

  it('skips with unattributed_card_present when a card since turn start carries no turn id', async () => {
    // The mixed-version case: an older runtime image registered the card
    // without a turnId. Not evidence either way, so the reply stands.
    mockCount.mockResolvedValue({ attributed: 0, unattributed: 1 });
    expect(await checkAttachmentClaim({ ...base, text: CLAIM })).toEqual({
      text: CLAIM,
      finding: { kind: 'skipped', reason: 'unattributed_card_present', detail: { unattributed: 1 } },
    });
  });

  it('skips with lookup_failed when the count throws, rather than reading the error as "no cards"', async () => {
    mockCount.mockRejectedValue(new Error('connection reset'));
    expect(await checkAttachmentClaim({ ...base, text: CLAIM })).toEqual({
      text: CLAIM,
      finding: { kind: 'skipped', reason: 'lookup_failed', detail: { error: 'connection reset' } },
    });
  });

  it('skips with lookup_failed when the turn is not on record — its start cannot be established', async () => {
    mockCount.mockResolvedValue(null);
    expect(await checkAttachmentClaim({ ...base, text: CLAIM })).toEqual({
      text: CLAIM,
      finding: { kind: 'skipped', reason: 'lookup_failed', detail: { turnFound: false } },
    });
  });

  it('skips with no_turn_id when the reply has no turn, without looking', async () => {
    expect(await checkAttachmentClaim({ ...base, turnId: null, text: CLAIM })).toEqual({
      text: CLAIM,
      finding: { kind: 'skipped', reason: 'no_turn_id' },
    });
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('does nothing at all for a reply that makes no claim', async () => {
    const text = 'I attached a note to the CRM record.';
    expect(await checkAttachmentClaim({ ...base, text })).toEqual({ text, finding: { kind: 'no_claim' } });
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('never logs while deciding — the row may not land', async () => {
    mockCount.mockResolvedValue({ attributed: 0, unattributed: 0 });
    await checkAttachmentClaim({ ...base, text: CLAIM });
    mockCount.mockRejectedValue(new Error('down'));
    await checkAttachmentClaim({ ...base, text: CLAIM });
    expect(logInfo).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });
});

describe('recordAttachmentClaimFinding', () => {
  const ids = { tenantId: 'tenant-1', threadId: 'thread-1', turnId: 'turn-1', invocationId: 'inv-1' };

  beforeEach(() => {
    logInfo.mockReset();
    logWarn.mockReset();
  });

  it('logs attachment_claim_unbacked with thread and invocation ids for the positive finding', () => {
    recordAttachmentClaimFinding({ kind: 'unbacked' }, ids);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'attachment_claim_unbacked', threadId: 'thread-1', invocationId: 'inv-1', turnId: 'turn-1' }),
      expect.any(String),
    );
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('logs attachment_claim_check_skipped with the reason and its detail', () => {
    recordAttachmentClaimFinding({ kind: 'skipped', reason: 'unattributed_card_present', detail: { unattributed: 2 } }, ids);
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'attachment_claim_check_skipped', reason: 'unattributed_card_present', unattributed: 2 }),
      expect.any(String),
    );
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('logs nothing for a backed claim or no claim', () => {
    recordAttachmentClaimFinding({ kind: 'backed' }, ids);
    recordAttachmentClaimFinding({ kind: 'no_claim' }, ids);
    expect(logInfo).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });
});
