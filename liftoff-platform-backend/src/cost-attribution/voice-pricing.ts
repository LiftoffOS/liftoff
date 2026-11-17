// Voice vendor pricing.
//
// The single place voice rates live. Adapters report usage in their own native
// unit and call in here to convert; nothing else in the tree holds a voice
// price, so a vendor price change is a one-line edit here plus a re-run of the
// pricing tests.
//
// Why per-adapter conversion at all, rather than one shared "voice cost"
// function: voice vendors do not agree on a unit, and the disagreement is not
// even consistent within a single vendor. Verified 2026-08-05:
//
//   characters    ElevenLabs (all models), MiniMax, OpenAI tts-1/tts-1-hd, and
//                 the Chirp 3: HD / Standard / WaveNet / Studio Cloud TTS voices
//   audio tokens  Gemini-TTS — INCLUDING when called through the Cloud TTS
//                 endpoint, so the native provider alone spans both units — and
//                 OpenAI gpt-4o-mini-tts
//   audio seconds Google STT, whisper-1 and gpt-transcribe, billed per minute —
//                 but NOT every OpenAI transcription model: gpt-4o-transcribe
//                 and gpt-4o-mini-transcribe answer the same request with token
//                 counts instead, so the unit is a property of the MODEL and not
//                 of the capability. Picking a model is therefore picking a unit
//                 (see OPENAI_STT_USD_PER_MINUTE).
//
// A shared character counter would therefore silently mis-price half the set.
// The ledger sees only USD (ingestEventWithBuckets takes USD and nothing else),
// which is what keeps that variety out of the OU maths entirely.

import type { VoiceBillingUnit } from '../voice/types';

/**
 * Rate card, keyed by the vendor model id that appears in
 * src/voice/vendors.ts.
 *
 * Every entry carries the unit it is quoted in, so a mismatch between what an
 * adapter measured and what the rate assumes is a type error rather than a
 * silent factor-of-sixty.
 */
interface VoiceRate {
  unit: VoiceBillingUnit;
  /** USD per ONE unit — per character, per audio token, or per audio second. */
  usdPerUnit: number;
  /** Where the number came from and when it was checked. */
  source: string;
}

/**
 * Verified 2026-08-05 from the Cloud Billing Catalog API
 * (cloudbilling.googleapis.com/v1/services/63DE-82AB-F564/skus — "Cloud
 * Speech-to-Text Recognition"), not from the marketing pricing page, which does
 * not render to a fetchable table.
 *
 * $0.016 per minute at the base tier, i.e. $0.016 / 60 per second. Volume tiers
 * exist ($0.010 above 500 K minutes, $0.008 above 1 M, $0.004 above 2 M) and are
 * deliberately NOT modelled: below the first tier the base rate is what bills,
 * and a tiered estimate that guesses which side of a monthly boundary a single
 * utterance lands on would be less accurate, not more.
 */
const GOOGLE_STT_USD_PER_MINUTE = 0.016;

/**
 * Verified 2026-08-06 from the Cloud Billing Catalog API
 * (cloudbilling.googleapis.com/v1/services/02DA-B362-D983/skus — SKU "Count of
 * characters for Chirp3-HD voices"). That SKU has two tiers: $0 up to 1,000,000
 * characters in a month, then $0.000030 per character.
 *
 * WE BILL THE MARGINAL RATE, AND TREAT THE FREE MILLION AS PLATFORM OVERHEAD.
 * The allowance is monthly and project-wide, so charging it through would mean
 * whichever tenants happened to speak earliest in a month got free speech and
 * the rest paid — the same cost for the same work, priced by luck. Billing every
 * character at $0.000030 is stable, reconciles against the invoice as an
 * over-collection rather than a shortfall, and matches how the platform already
 * treats fixed monthly vendor fees.
 */
const GOOGLE_TTS_USD_PER_CHARACTER = 0.00003;

/**
 * OpenAI gpt-4o-mini-tts. Verified 2026-08-05 (§8.1 of the voice design): $0.60
 * per 1M text input tokens and $12.00 per 1M audio output tokens.
 *
 * Two rates, which is why this model gets its own function rather than a row in
 * the table: the table maps one unit to one price, and this one charges for what
 * it read and what it produced at prices twenty times apart.
 */
const OPENAI_SPEECH_USD_PER_INPUT_TOKEN = 0.0000006;
const OPENAI_SPEECH_USD_PER_OUTPUT_TOKEN = 0.000012;

/**
 * OpenAI gpt-transcribe. Verified 2026-08-10 from the model page
 * (developers.openai.com/api/docs/models/gpt-transcribe): $0.0045 per minute of
 * audio.
 *
 * A DURATION rate, and that is why this is the transcription model we run.
 * OpenAI's transcription models disagree with each other about what they report:
 * gpt-4o-transcribe and gpt-4o-mini-transcribe answer with token counts
 * (`{type:'tokens', input_token_details:{audio_tokens}}`) whose audio-input rate
 * OpenAI does not publish separately from text input, so pricing them means
 * guessing a factor. gpt-transcribe reports `{type:'duration', seconds}` against
 * a published per-minute price — the same shape Google STT already reports, so
 * both vendors land on `audio_seconds` and the ledger cannot tell them apart.
 */
const OPENAI_STT_USD_PER_MINUTE = 0.0045;

/**
 * What one gpt-4o-mini-tts call cost, from the usage the vendor reported.
 *
 * Reported rather than estimated: the SSE stream ends with a `speech.audio.done`
 * event carrying real token counts, so nothing here has to guess how many audio
 * tokens a sentence became.
 */
export function openaiSpeechCostUsd(inputTokens: number, outputTokens: number): number {
  const input = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const output = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return input * OPENAI_SPEECH_USD_PER_INPUT_TOKEN + output * OPENAI_SPEECH_USD_PER_OUTPUT_TOKEN;
}

const VOICE_RATES: Record<string, VoiceRate> = {
  // Cloud Speech-to-Text v2, general-purpose recognizer.
  long: {
    unit: 'audio_seconds',
    usdPerUnit: GOOGLE_STT_USD_PER_MINUTE / 60,
    source: 'GCP Billing Catalog SKU "Cloud Speech-to-Text Recognition", $0.016/min, checked 2026-08-05',
  },
  // OpenAI Realtime transcription, and the batch transcriptions endpoint.
  'gpt-transcribe': {
    unit: 'audio_seconds',
    usdPerUnit: OPENAI_STT_USD_PER_MINUTE / 60,
    source: 'OpenAI model page for gpt-transcribe, $0.0045/min, checked 2026-08-10',
  },
  'gpt-4o-mini-tts': {
    unit: 'audio_tokens',
    usdPerUnit: OPENAI_SPEECH_USD_PER_OUTPUT_TOKEN,
    source: 'OpenAI published rate, $12/1M audio output tokens, checked 2026-08-05',
  },
  // Cloud Text-to-Speech, Chirp 3: HD voices.
  'chirp-3-hd': {
    unit: 'characters',
    usdPerUnit: GOOGLE_TTS_USD_PER_CHARACTER,
    source:
      'GCP Billing Catalog SKU "Count of characters for Chirp3-HD voices", $30/1M chars above a 1M/month free tier, checked 2026-08-06',
  },
};

/**
 * Convert a vendor-native quantity into USD.
 *
 * Throws on an unknown model rather than returning zero. A zero here would look
 * exactly like a free call and would under-charge the tenant silently, which is
 * the failure this whole layer is arranged to prevent — an unpriced model is a
 * bug in the vendor map, and it should stop the call that discovered it.
 */
export function voiceUsageToCostUsd(
  model: string,
  quantity: number,
  unit: VoiceBillingUnit,
): number {
  const rate = VOICE_RATES[model];
  if (!rate) {
    throw new Error(`No voice rate configured for model '${model}'`);
  }
  if (rate.unit !== unit) {
    throw new Error(
      `Voice rate for '${model}' is quoted in ${rate.unit} but usage was reported in ${unit}`,
    );
  }
  if (!Number.isFinite(quantity) || quantity < 0) return 0;
  return quantity * rate.usdPerUnit;
}
