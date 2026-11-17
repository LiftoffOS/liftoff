/**
 * Google bills thinking as output and the tool-result prompt as input, and this
 * provider counted neither.
 *
 * Four counts arrive on `usageMetadata` and none contains another — the SDK states
 * the arithmetic itself: `totalTokenCount` is prompt + candidates + toolUsePrompt +
 * thoughts. Reading `promptTokenCount` and `candidatesTokenCount` alone therefore
 * charges for the visible answer and nothing for the reasoning that produced it,
 * which on a Gemini 3 model is most of the call.
 *
 * Platform-assistant spend is chargeable (INV-PB-017), so this is money, not a
 * reporting nicety. Today's prod Google rows are embeddings, which have no
 * thinking — so the defect is latent rather than live, and it goes live the moment
 * a platform vendor lever moves an area to Google.
 */

import { googleInputTokens, googleOutputTokens } from '../google-usage';

describe('what Google bills, from its own usage metadata', () => {
  it('counts thinking as output, because that is the rate Google charges it at', () => {
    expect(googleOutputTokens({ candidatesTokenCount: 40, thoughtsTokenCount: 3_500 })).toBe(3_540);
  });

  it('counts the tool-result prompt as input, which is where Google puts it', () => {
    expect(googleInputTokens({ promptTokenCount: 1_200, toolUsePromptTokenCount: 800 })).toBe(2_000);
  });

  it('adds up to the total Google reports, which is the whole point', () => {
    // `totalTokenCount` is the vendor's own sum. If our two figures do not
    // reconstruct it, we are billing a different call than the one that ran.
    const u = {
      promptTokenCount: 1_200,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 3_500,
      toolUsePromptTokenCount: 800,
    };
    const total = 1_200 + 40 + 3_500 + 800;
    expect(googleInputTokens(u) + googleOutputTokens(u)).toBe(total);
  });

  it('is unchanged for a turn with neither, so nothing already-correct moves', () => {
    expect(googleInputTokens({ promptTokenCount: 500 })).toBe(500);
    expect(googleOutputTokens({ candidatesTokenCount: 120 })).toBe(120);
  });

  it('treats absent counts as zero rather than NaN', () => {
    expect(googleInputTokens({})).toBe(0);
    expect(googleOutputTokens({})).toBe(0);
  });
});
