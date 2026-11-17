// The paraphrase half, and the three properties that make it safe to put in
// front of a person's reply: it can only remove, it fails open, and it stands
// aside rather than making every paragraph wait out a dead provider.
//
// The judge is a seam here. What is under test is not whether a small model
// answers the question well — that is the model's job and the rubric's — but
// that NOTHING it can return damages the reply.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import {
  removeBriefRestatement,
  onlyRemoves,
  _resetBriefRestatementState,
} from '../brief-restatement';
import { logAudit } from '../../infrastructure/logging';

const ctx = { tenantId: 't-1', speaker: 'caio', threadId: 'th-1' };
const BRIEF = 'They want to know whether archiving an agent destroys its history. Confirm before advising them.';

beforeEach(() => {
  _resetBriefRestatementState();
  jest.clearAllMocks();
});

describe('what the reader is allowed to do', () => {
  it('removes a paraphrase of the brief and keeps the answer', async () => {
    const paragraph =
      'Let me make sure the archive behaviour is right before I advise you. '
      + 'Removing an agent takes it out of your workspace.';
    const judge = async () => ({ removed: true, text: 'Removing an agent takes it out of your workspace.' });

    const out = await removeBriefRestatement(paragraph, BRIEF, ctx, judge);
    expect(out.text).toBe('Removing an agent takes it out of your workspace.');
    expect(out.removed).toBe(1);
    expect(logAudit).toHaveBeenCalledWith(
      'brief_echo.removed',
      { tenantId: 't-1' },
      expect.objectContaining({ kind: 'paraphrase', sentencesRemoved: 1 }),
    );
  });

  it('removes the whole paragraph when all of it is the brief', async () => {
    const paragraph = 'Let me confirm this before advising them.';
    const judge = async () => ({ removed: true, text: '' });
    const out = await removeBriefRestatement(paragraph, BRIEF, ctx, judge);
    expect(out.text).toBe('');
    expect(out.removed).toBe(1);
  });

  it('keeps the paragraph when the reader says there is nothing to remove', async () => {
    const paragraph = 'Removing an agent takes it out of your workspace.';
    const judge = async () => ({ removed: false, text: paragraph });
    expect(await removeBriefRestatement(paragraph, BRIEF, ctx, judge)).toEqual({ text: paragraph, removed: 0 });
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('what the reader cannot do, whatever it returns', () => {
  it('discards a rewrite and keeps the paragraph as the colleague wrote it', async () => {
    const paragraph = 'I have removed the Release Coordinator. It is off your Teams page.';
    // A "helpful" tidy-up. Every word is plausible and none of it is the
    // colleague's, so it is thrown away whole.
    const judge = async () => ({ removed: true, text: 'The Release Coordinator has been removed.' });
    const out = await removeBriefRestatement(paragraph, BRIEF, ctx, judge);
    expect(out).toEqual({ text: paragraph, removed: 0 });
  });

  it('discards an addition, even alongside a legitimate removal', async () => {
    const paragraph = 'Let me check first. I have removed the Release Coordinator.';
    const judge = async () => ({
      removed: true,
      text: 'I have removed the Release Coordinator. Let me know if you need anything else.',
    });
    const out = await removeBriefRestatement(paragraph, BRIEF, ctx, judge);
    expect(out).toEqual({ text: paragraph, removed: 0 });
  });

  it('keeps the paragraph when the reader throws', async () => {
    const paragraph = 'I have removed the Release Coordinator.';
    const judge = async () => { throw new Error('provider exploded') };
    expect(await removeBriefRestatement(paragraph, BRIEF, ctx, judge)).toEqual({ text: paragraph, removed: 0 });
  });

  it('stands aside after three failures in a row, rather than waiting each time', async () => {
    const paragraph = 'I have removed the Release Coordinator.';
    let calls = 0;
    const failing = async () => { calls++; throw new Error('down') };
    for (let i = 0; i < 3; i++) await removeBriefRestatement(paragraph, BRIEF, ctx, failing);
    expect(calls).toBe(3);

    // The fourth is not attempted at all.
    let asked = false;
    const watching = async () => { asked = true; return { removed: true, text: '' } };
    const out = await removeBriefRestatement(paragraph, BRIEF, ctx, watching);
    expect(asked).toBe(false);
    expect(out).toEqual({ text: paragraph, removed: 0 });
  });
});

describe('onlyRemoves', () => {
  it('accepts a subset of the sentences, in order, with whitespace closed up', () => {
    expect(onlyRemoves('One. Two. Three.', 'One. Three.')).toBe(true);
    expect(onlyRemoves('One.\n\nTwo.', 'Two.')).toBe(true);
    expect(onlyRemoves('One. Two.', '')).toBe(true);
  });

  it('rejects a sentence that was not written, however small the change', () => {
    expect(onlyRemoves('I removed the team.', 'I have removed the team.')).toBe(false);
    expect(onlyRemoves('One. Two.', 'One. Four.')).toBe(false);
  });

  it('accepts a fenced block returned as it was', () => {
    const before = 'Here is the schedule:\n\n```\n0 9 * * 1\n```\n';
    expect(onlyRemoves(before, before)).toBe(true);
  });
});
