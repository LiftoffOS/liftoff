// Voice on Slack and Teams, where the rule is that audio is a bonus.
//
// The failure this file exists to prevent: a vendor outage, or a workspace that
// has not re-consented to the file scopes, costing somebody their answer. Every
// path here has to fail soft.

const recognizeFile = jest.fn();
const synthesizeFile = jest.fn();
const recordDictationCost = jest.fn().mockResolvedValue(undefined);
const recordSynthesisCost = jest.fn().mockResolvedValue(undefined);

jest.mock('../registry', () => ({
  resolveSttProvider: () => ({ key: 'google', recognizeFile }),
  resolveTtsProvider: () => ({ key: 'google', synthesizeFile }),
  vendorForLane: () => 'google',
}));
jest.mock('../cost', () => ({
  recordDictationCost: (...args: unknown[]) => recordDictationCost(...args),
  recordSynthesisCost: (...args: unknown[]) => recordSynthesisCost(...args),
}));

import { transcribeVoiceMemo, recordMemoCost, speakReply } from '../chat-audio';

const MEMO = {
  tenantId: 'tenant-1',
  surface: 'slack' as const,
  audio: Buffer.from('pretend audio'),
  mimeType: 'audio/mp4',
  sourceId: 'slack:T1:123.456',
};

const USAGE = { quantity: 4, unit: 'audio_seconds' as const, model: 'long', costUsd: 0.001 };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('transcribeVoiceMemo', () => {
  it('returns the words and the usage, and does NOT bill yet', async () => {
    // Billing here was the bug: on Slack the transcript is what decides which
    // teammate is addressed, so no agent is known at this point — and
    // classifyChargeability will not honour a customer purpose without one, so
    // every memo was absorbed instead of charged.
    recognizeFile.mockResolvedValue({ transcript: 'what happened to the forecast', usage: USAGE });
    const memo = await transcribeVoiceMemo(MEMO);
    expect(memo?.transcript).toBe('what happened to the forecast');
    expect(memo?.usage).toEqual(USAGE);
    expect(recordDictationCost).not.toHaveBeenCalled();
  });

  it('returns usage for a silent memo, so it can still be billed', async () => {
    // Listening was charged whether or not it heard anything.
    recognizeFile.mockResolvedValue({ transcript: '', usage: USAGE });
    const memo = await transcribeVoiceMemo(MEMO);
    expect(memo?.transcript).toBe('');
    expect(memo?.usage).toEqual(USAGE);
  });

  it('bills to the agent the message reached', async () => {
    recognizeFile.mockResolvedValue({ transcript: 'hello', usage: USAGE });
    const memo = await transcribeVoiceMemo(MEMO);
    await recordMemoCost({
      tenantId: 'tenant-1', surface: 'slack', agentId: 'agent-1',
      memo: memo!, sourceId: 'slack:T1:1',
    });
    expect(recordDictationCost).toHaveBeenCalledWith(
      // The agent id is what makes this customer-charged rather than absorbed.
      expect.objectContaining({ surface: 'slack', agentId: 'agent-1', usage: USAGE }),
    );
  });

  it('swallows a vendor failure rather than throwing into a webhook', async () => {
    recognizeFile.mockRejectedValue(new Error('PERMISSION_DENIED'));
    await expect(transcribeVoiceMemo(MEMO)).resolves.toBeNull();
  });

  it('refuses a file that is not audio, without calling the vendor', async () => {
    await expect(
      transcribeVoiceMemo({ ...MEMO, mimeType: 'application/pdf' }),
    ).resolves.toBeNull();
    expect(recognizeFile).not.toHaveBeenCalled();
  });

  it('refuses an oversized upload before it becomes a billed failure', async () => {
    await expect(
      transcribeVoiceMemo({ ...MEMO, audio: Buffer.alloc(9 * 1024 * 1024) }),
    ).resolves.toBeNull();
    expect(recognizeFile).not.toHaveBeenCalled();
  });
});

describe('speakReply', () => {
  const REPLY = {
    tenantId: 'tenant-1',
    surface: 'slack' as const,
    agentId: 'agent-1',
    text: 'Two deals need a decision today.',
    sourceId: 'slack:C1:123.456',
  };
  const AUDIO = {
    audio: Buffer.from('mp3'),
    mimeType: 'audio/mpeg',
    usage: { quantity: 31, unit: 'characters' as const, model: 'chirp-3-hd', costUsd: 0.001 },
  };

  it('returns a playable file and bills for it', async () => {
    synthesizeFile.mockResolvedValue(AUDIO);
    const spoken = await speakReply(REPLY);
    expect(spoken?.mimeType).toBe('audio/mpeg');
    expect(spoken?.filename).toMatch(/\.mp3$/);
    expect(recordSynthesisCost).toHaveBeenCalled();
  });

  it('shortens a long reply rather than making audio nobody will play', async () => {
    synthesizeFile.mockResolvedValue(AUDIO);
    await speakReply({ ...REPLY, text: 'This is a full sentence. '.repeat(200) });
    const spokenText = synthesizeFile.mock.calls[0]?.[0]?.text as string;
    expect(spokenText.length).toBeLessThan(2000);
    expect(spokenText).toMatch(/rest of my answer is in the message\.$/);
  });

  it('returns null when synthesis fails, so the written reply still stands', async () => {
    // The reply has already been delivered by the time this runs. A vendor
    // failure here must cost a listener their audio and nobody their answer.
    synthesizeFile.mockRejectedValue(new Error('quota exceeded'));
    await expect(speakReply(REPLY)).resolves.toBeNull();
  });

  it('says nothing when the vendor returned an empty file', async () => {
    // An empty buffer is not a spoken reply. Uploading it would put a
    // zero-second clip in the thread, which reads as broken.
    synthesizeFile.mockResolvedValue({ ...AUDIO, audio: Buffer.alloc(0) });
    await expect(speakReply(REPLY)).resolves.toBeNull();
    expect(recordSynthesisCost).not.toHaveBeenCalled();
  });
});
