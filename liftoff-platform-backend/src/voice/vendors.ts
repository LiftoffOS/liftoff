// Voice vendor map and lane assignments — the switchability seam.
//
// Layered exactly like src/model-registry/workspace-ai-vendors.ts, which solved
// this same problem for LLM vendors:
//
//   VOICE_LANE_ASSIGNMENTS  lane -> { vendor }.  NO model names.
//   VOICE_VENDORS           vendor -> capability -> { model, billingUnit }.
//                           The ONLY place vendor model names exist.
//
// Moving a lane to another vendor is a one-line assignments edit; changing what
// a vendor's model is, is a one-line vendor-map edit and it moves every lane
// pointing at that vendor consistently.
//
// This module holds DATA ONLY and imports nothing from ./providers. Adapters
// read their own entry from VOICE_VENDORS (so no adapter hardcodes a model id),
// and ./registry.ts is where adapters and lanes are wired together. Keeping the
// data here rather than in the registry is what makes that possible without an
// import cycle.
//
// One thing deliberately NOT copied from workspace-ai-vendors: that module
// MATERIALIZES its assignments into each tenant's model_configs row at write
// time, which is why editing a constant there does not reach already-stamped
// tenants and needs scripts/restamp-workspace-ai-policies.ts. Voice resolves on
// every call, so a vendor change takes effect everywhere at once, with no
// backfill and no split brain between old and new tenants.
//
// Rates are NOT here. They live in src/cost-attribution/voice-pricing.ts, the
// single place voice vendor pricing exists, so a price change never touches this
// file and an adapter never hardcodes a number.

import type { VoiceBillingUnit, VoiceLane } from './types';

/** Vendors the registry knows about. Adapters exist for a subset (see ./registry). */
export type VoiceVendorKey = 'google' | 'openai' | 'elevenlabs';

export interface VoiceModelSpec {
  /** The vendor's own model id. This file is the only place these appear. */
  model: string;
  /** How this vendor bills the model — drives the ledger row's usage_unit. */
  billingUnit: VoiceBillingUnit;
}

interface VoiceVendorSpec {
  stt?: VoiceModelSpec;
  tts?: VoiceModelSpec;
}

/**
 * Vendor -> capability -> model.
 *
 * Verified against live vendor docs 2026-08-05. Google STT bills per minute of
 * audio (recorded here as audio_seconds, the finer unit its API reports);
 * ElevenLabs bills per character.
 */
export const VOICE_VENDORS: Record<VoiceVendorKey, VoiceVendorSpec> = {
  google: {
    // Cloud Speech-to-Text v2. 'long' is the general-purpose recognizer model.
    stt: { model: 'long', billingUnit: 'audio_seconds' },
    // Chirp 3: HD. Cloud TTS has no model parameter — the voice name selects the
    // family — so this id names the family for the ledger and pricing, and the
    // concrete voice comes from the agent's slot (./voice-identity).
    tts: { model: 'chirp-3-hd', billingUnit: 'characters' },
  },
  openai: {
    // Realtime transcription, and the batch transcriptions endpoint. Chosen over
    // gpt-4o-transcribe and gpt-4o-mini-transcribe because it reports DURATION
    // where they report token counts whose audio-input rate OpenAI does not
    // publish; and over gpt-live-transcribe, which refuses turn detection and so
    // never commits a buffer, never settles a transcript and never reports usage.
    // The reasoning in full is at the top of ./providers/openai-stt.
    stt: { model: 'gpt-transcribe', billingUnit: 'audio_seconds' },
    // Audio TOKENS, not characters — and that is fine. VoiceBillingUnit has
    // carried 'audio_tokens' since the beginning precisely for this model; an
    // earlier version of this entry picked tts-1 to keep every lane on
    // characters, which traded 2-3x the latency for a tidier ledger. Measured:
    // gpt-4o-mini-tts answers in ~0.8s against tts-1's ~2.5s.
    tts: { model: 'gpt-4o-mini-tts', billingUnit: 'audio_tokens' },
  },
  elevenlabs: {
    tts: { model: 'eleven_flash_v2_5', billingUnit: 'characters' },
  },
};

/**
 * Lane -> vendor. The whole switchability story is that this table is the only
 * thing that has to change to move a lane to another vendor.
 *
 * All four lanes are assigned, but only the lanes whose vendor has a registered
 * adapter resolve. The rest throw loudly rather than silently falling back to a
 * different vendor.
 *
 * ALL FOUR LANES ARE OPENAI, and the point is not the vendor. Both vendors
 * implement both capabilities, so the table below is four independent choices
 * rather than a single one wearing four hats: any
 * lane can be moved back to `google` on its own line, and the tests in
 * __tests__/vendors.test.ts exercise the move in both directions.
 *
 * See ADR-048 (docs/adr/048-voice-vendor-switchability.md) for the model choice
 * and for why an unassigned lane hides adapter defects: nothing ever calls the
 * adapter.
 *
 * ElevenLabs stays in the map with no adapter and no rate: it is the case that
 * proves a lane pointed at an unbuilt vendor fails loudly instead of silently
 * speaking in a voice nobody chose. It is ruled out on commercial grounds
 * — it sells monthly subscriptions, and a fixed floor
 * cannot sit under usage billing that has to scale cleanly from zero.
 */
export const VOICE_LANE_ASSIGNMENTS: Record<VoiceLane, { vendor: VoiceVendorKey }> = {
  dictation_stt: { vendor: 'openai' },
  conversation_stt: { vendor: 'openai' },
  conversation_tts: { vendor: 'openai' },
  memo_tts: { vendor: 'openai' },
};

/**
 * The STT model a vendor is configured to use.
 *
 * Adapters call this for their OWN vendor key rather than hardcoding a model id,
 * which is what keeps VOICE_VENDORS the single source for those strings.
 */
export function sttModelFor(vendor: VoiceVendorKey): VoiceModelSpec {
  const spec = VOICE_VENDORS[vendor].stt;
  if (!spec) {
    throw new Error(`Vendor '${vendor}' declares no STT model`);
  }
  return spec;
}

/** The TTS model a vendor is configured to use. Counterpart of `sttModelFor`. */
export function ttsModelFor(vendor: VoiceVendorKey): VoiceModelSpec {
  const spec = VOICE_VENDORS[vendor].tts;
  if (!spec) {
    throw new Error(`Vendor '${vendor}' declares no TTS model`);
  }
  return spec;
}
