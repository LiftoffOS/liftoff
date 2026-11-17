import { openaiSpeechCostUsd, voiceUsageToCostUsd } from '../voice-pricing';

describe('voice pricing', () => {
  it('prices a minute of listening at the published rate', () => {
    // $0.016/min, so 60 seconds is $0.016 exactly.
    expect(voiceUsageToCostUsd('long', 60, 'audio_seconds')).toBeCloseTo(0.016, 10);
  });

  it('prices a million spoken characters at thirty dollars', () => {
    expect(voiceUsageToCostUsd('chirp-3-hd', 1_000_000, 'characters')).toBeCloseTo(30, 6);
  });

  it('charges the marginal rate from the first character, free tier or not', () => {
    // The 1M/month allowance is deliberately not modelled: it is project-wide, so
    // passing it through would price identical work differently depending on who
    // spoke first that month.
    expect(voiceUsageToCostUsd('chirp-3-hd', 1, 'characters')).toBeCloseTo(0.00003, 12);
  });

  it('refuses to price a vendor that was ruled out', () => {
    // ElevenLabs was declined on commercial grounds: a monthly subscription
    // cannot sit under usage billing that scales from zero. Its rate is gone, so
    // pointing a lane at it fails loudly rather than billing a stale number.
    expect(() => voiceUsageToCostUsd('eleven_flash_v2_5', 1_000, 'characters')).toThrow(
      /No voice rate configured/,
    );
  });

  it('prices a spoken reply from the tokens the vendor reported', () => {
    // $0.60/1M in, $12.00/1M out. Two rates twenty times apart, which is why
    // this model gets a function rather than a row.
    expect(openaiSpeechCostUsd(1_000_000, 0)).toBeCloseTo(0.6, 6);
    expect(openaiSpeechCostUsd(0, 1_000_000)).toBeCloseTo(12, 6);
    // The measured shape of a short sentence: input is a rounding error.
    expect(openaiSpeechCostUsd(3, 50)).toBeCloseTo(0.0006018, 9);
  });

  it('treats missing or nonsense token counts as zero, not NaN', () => {
    expect(openaiSpeechCostUsd(Number.NaN, 50)).toBeCloseTo(0.0006, 9);
    expect(openaiSpeechCostUsd(-5, -5)).toBe(0);
  });

  it('refuses a unit the rate is not quoted in', () => {
    // Seconds against a per-character rate would silently under-bill by orders
    // of magnitude, which is precisely the failure this guard exists for.
    expect(() => voiceUsageToCostUsd('chirp-3-hd', 100, 'audio_seconds')).toThrow(
      /quoted in characters/,
    );
    expect(() => voiceUsageToCostUsd('long', 100, 'characters')).toThrow(/quoted in audio_seconds/);
  });

  it('refuses an unpriced model rather than calling it free', () => {
    expect(() => voiceUsageToCostUsd('some-new-voice', 100, 'characters')).toThrow(
      /No voice rate configured/,
    );
  });

  it('treats nonsense quantities as zero rather than NaN', () => {
    expect(voiceUsageToCostUsd('chirp-3-hd', Number.NaN, 'characters')).toBe(0);
    expect(voiceUsageToCostUsd('chirp-3-hd', -5, 'characters')).toBe(0);
  });
});
