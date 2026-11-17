// Lane -> adapter resolution.
//
// Split from ./vendors.ts so that vendors.ts can stay import-free and adapters
// can read their own model id from it without a cycle. This module is the only
// place that knows both the lane table and the adapter instances.

import type { SttProvider, TtsProvider, VoiceLane } from './types';
import { VOICE_LANE_ASSIGNMENTS, type VoiceVendorKey } from './vendors';
import { googleSttProvider } from './providers/google-stt';
import { googleTtsProvider } from './providers/google-tts';
import { openaiSttProvider } from './providers/openai-stt';
import { openaiTtsProvider } from './providers/openai-tts';

/**
 * Registered STT adapters, keyed by vendor. Absent vendor = adapter not built yet.
 *
 * Two real ones, so a listening lane can now be moved with the same one-line
 * edit a speaking lane always could. While this held only `google`, half the
 * lane table was decoration: pointing dictation anywhere else produced an
 * exception rather than a different vendor.
 */
const STT_PROVIDERS: Partial<Record<VoiceVendorKey, SttProvider>> = {
  google: googleSttProvider,
  openai: openaiSttProvider,
};

/**
 * Registered TTS adapters.
 *
 * Two real ones, which is what makes the lane table more than a claim: moving
 * `conversation_tts` between 'google' and 'openai' is a one-line edit and the
 * whole speaking path follows. ElevenLabs stays absent — declined on commercial
 * grounds — as the case proving an unbuilt vendor throws instead of silently
 * substituting.
 */
const TTS_PROVIDERS: Partial<Record<VoiceVendorKey, TtsProvider>> = {
  google: googleTtsProvider,
  openai: openaiTtsProvider,
};

/**
 * Resolve the STT adapter for a lane.
 *
 * `tenantId` is accepted but unused. A tenant-supplied vendor credential would
 * override the lane HERE rather than in any caller, so taking the parameter now
 * keeps that change confined to this function.
 *
 * Throws when the lane's vendor has no adapter. That is deliberate — the
 * alternative is silently transcribing on a vendor the operator did not choose,
 * and "never silently swap" is a standing rule of this layer.
 */
export function resolveSttProvider(lane: VoiceLane, _tenantId: string): SttProvider {
  const assignment = VOICE_LANE_ASSIGNMENTS[lane];
  const provider = STT_PROVIDERS[assignment.vendor];
  if (!provider) {
    throw new Error(
      `No STT adapter registered for vendor '${assignment.vendor}' (lane '${lane}')`,
    );
  }
  return provider;
}

/** Resolve the TTS adapter for a lane. Same contract as `resolveSttProvider`. */
export function resolveTtsProvider(lane: VoiceLane, _tenantId: string): TtsProvider {
  const assignment = VOICE_LANE_ASSIGNMENTS[lane];
  const provider = TTS_PROVIDERS[assignment.vendor];
  if (!provider) {
    throw new Error(
      `No TTS adapter registered for vendor '${assignment.vendor}' (lane '${lane}')`,
    );
  }
  return provider;
}

/** The vendor a lane currently resolves to. The speak path needs it to pick a voice. */
export function vendorForLane(lane: VoiceLane): VoiceVendorKey {
  return VOICE_LANE_ASSIGNMENTS[lane].vendor;
}
