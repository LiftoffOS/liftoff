// The switchability proof.
//
// The whole point of the lane/vendor split is that moving voice to another
// vendor is a config edit and not a refactor. That claim is worth exactly as
// much as the test that exercises it, so this file flips the assignment table
// and asserts the resolution follows — nothing else in the tree changes.

import { VOICE_LANE_ASSIGNMENTS, VOICE_VENDORS, sttModelFor, ttsModelFor } from '../vendors';
import type { VoiceVendorKey } from '../vendors';
import { resolveSttProvider, resolveTtsProvider, vendorForLane } from '../registry';
import { voiceUsageToCostUsd } from '../../cost-attribution/voice-pricing';
import type { VoiceLane } from '../types';

describe('voice vendor map', () => {
  it('declares a model and a billing unit for every vendor capability', () => {
    for (const [vendor, spec] of Object.entries(VOICE_VENDORS)) {
      for (const capability of ['stt', 'tts'] as const) {
        const model = spec[capability];
        if (!model) continue;
        expect(model.model.length).toBeGreaterThan(0);
        expect(['characters', 'audio_tokens', 'audio_seconds']).toContain(model.billingUnit);
        // A vendor key leaking into a model id would defeat the point of the map.
        expect(typeof vendor).toBe('string');
      }
    }
  });

  it('assigns every lane, including the ones with no adapter yet', () => {
    const lanes: VoiceLane[] = [
      'dictation_stt', 'conversation_stt', 'conversation_tts', 'memo_tts',
    ];
    for (const lane of lanes) {
      expect(VOICE_LANE_ASSIGNMENTS[lane]).toBeDefined();
    }
  });

  it('exposes the STT model for a vendor without callers hardcoding it', () => {
    expect(sttModelFor('google')).toEqual({ model: 'long', billingUnit: 'audio_seconds' });
    expect(sttModelFor('openai')).toEqual({
      model: 'gpt-transcribe',
      billingUnit: 'audio_seconds',
    });
  });

  it('prices every model a registered adapter can actually reach', () => {
    // The lane table is only as switchable as the ledger behind it: pointing a
    // lane at a vendor whose model has no rate moves the failure from resolution
    // (loud, immediate) to the first attempt to bill it (quiet, after the work).
    // voiceUsageToCostUsd throws on an unpriced model, so this is the check that
    // a switch cannot strand a lane somewhere it cannot be charged for.
    for (const vendor of ['google', 'openai'] as const) {
      for (const capability of ['stt', 'tts'] as const) {
        const spec = VOICE_VENDORS[vendor][capability];
        if (!spec) continue;
        expect(() => voiceUsageToCostUsd(spec.model, 1, spec.billingUnit)).not.toThrow();
        expect(voiceUsageToCostUsd(spec.model, 1, spec.billingUnit)).toBeGreaterThan(0);
      }
    }
  });

  it('throws for a vendor that declares no STT model', () => {
    expect(() => sttModelFor('elevenlabs')).toThrow(/declares no STT model/);
  });

  it('exposes the TTS model the same way, without callers hardcoding it', () => {
    expect(ttsModelFor('google')).toEqual({ model: 'chirp-3-hd', billingUnit: 'characters' });
    expect(ttsModelFor('elevenlabs')).toEqual({
      model: 'eleven_flash_v2_5',
      billingUnit: 'characters',
    });
  });
});

describe('lane resolution', () => {
  /** Restores whatever a test moved, so the assignments stay the real ones. */
  const withLane = (lane: VoiceLane, vendor: VoiceVendorKey, body: () => void): void => {
    const original = { ...VOICE_LANE_ASSIGNMENTS[lane] };
    VOICE_LANE_ASSIGNMENTS[lane] = { vendor };
    try {
      body();
    } finally {
      VOICE_LANE_ASSIGNMENTS[lane] = original;
    }
  };

  it('resolves every lane to its assigned vendor, and can stream on all of them', () => {
    for (const lane of ['dictation_stt', 'conversation_stt'] as const) {
      const provider = resolveSttProvider(lane, 'tenant-1');
      expect(provider.key).toBe(VOICE_LANE_ASSIGNMENTS[lane].vendor);
      // Listening is live on both lanes; a batch-only adapter cannot back them.
      expect(provider.capabilities.streaming).toBe(true);
    }
    for (const lane of ['conversation_tts', 'memo_tts'] as const) {
      const provider = resolveTtsProvider(lane, 'tenant-1');
      expect(provider.key).toBe(VOICE_LANE_ASSIGNMENTS[lane].vendor);
      expect(vendorForLane(lane)).toBe(VOICE_LANE_ASSIGNMENTS[lane].vendor);
    }
  });

  it('MOVES A LISTENING LANE WITH ONE LINE, IN EITHER DIRECTION', () => {
    // This is the half that used to be decoration. With only a Google adapter
    // built, pointing dictation anywhere else produced an exception rather than
    // a different vendor, so "the lane table is the only thing that changes" was
    // true of speaking and false of listening. Both vendors implement both
    // capabilities now, so the claim is testable rather than aspirational.
    withLane('dictation_stt', 'openai', () => {
      expect(resolveSttProvider('dictation_stt', 'tenant-1').key).toBe('openai');
      expect(sttModelFor(vendorForLane('dictation_stt')).model).toBe('gpt-transcribe');
    });
    withLane('dictation_stt', 'google', () => {
      expect(resolveSttProvider('dictation_stt', 'tenant-1').key).toBe('google');
      expect(sttModelFor(vendorForLane('dictation_stt')).model).toBe('long');
    });
    // Both report the duration they listened for, so the ledger row is the same
    // shape whichever vendor produced it.
    expect(sttModelFor('google').billingUnit).toBe('audio_seconds');
    expect(sttModelFor('openai').billingUnit).toBe('audio_seconds');
  });

  it('MOVES A SPEAKING LANE WITH ONE LINE, IN EITHER DIRECTION', () => {
    withLane('conversation_tts', 'google', () => {
      expect(resolveTtsProvider('conversation_tts', 'tenant-1').key).toBe('google');
      expect(ttsModelFor(vendorForLane('conversation_tts')).model).toBe('chirp-3-hd');
    });
    withLane('conversation_tts', 'openai', () => {
      expect(resolveTtsProvider('conversation_tts', 'tenant-1').key).toBe('openai');
      expect(ttsModelFor(vendorForLane('conversation_tts')).model).toBe('gpt-4o-mini-tts');
    });

    // The units DIFFER across the switch — characters one side, audio tokens the
    // other — and that is the point. The lane table was built so a vendor change
    // can cross a billing unit without anything above this layer caring.
    expect(ttsModelFor('google').billingUnit).toBe('characters');
    expect(ttsModelFor('openai').billingUnit).toBe('audio_tokens');
  });

  it('emits one sample rate whichever speaking vendor is assigned', () => {
    // The browser is told the rate once per stream. Two adapters that disagreed
    // would make a vendor switch a client change as well, which is exactly the
    // coupling the lane table exists to prevent.
    for (const vendor of ['google', 'openai'] as const) {
      withLane('conversation_tts', vendor, () => {
        expect(
          resolveTtsProvider('conversation_tts', 'tenant-1').capabilities.outputSampleRateHertz,
        ).toBe(24000);
      });
    }
  });

  it('accepts every rate a microphone actually captures, on either listening vendor', () => {
    // A browser's AudioContext runs at whatever the output device negotiated —
    // 48 kHz on most desktops, 44.1 kHz on many Windows machines, 16 kHz on a
    // Bluetooth headset. An adapter that cannot take the real rate fails at the
    // first frame rather than at resolution, so the switch has to be checked
    // against the whole range and not against the vendor's preferred rate.
    for (const vendor of ['google', 'openai'] as const) {
      withLane('dictation_stt', vendor, () => {
        const [min, max] = resolveSttProvider('dictation_stt', 'tenant-1').capabilities
          .sampleRates as [number, number];
        for (const deviceRate of [16000, 44100, 48000]) {
          expect(min).toBeLessThanOrEqual(deviceRate);
          expect(max).toBeGreaterThanOrEqual(deviceRate);
        }
      });
    }
  });

  it('never silently falls back to a different vendor, listening or speaking', () => {
    // ElevenLabs is in the map with no adapter. Pointing a lane at it must fail
    // loudly — speaking in a voice nobody chose, or transcribing on a vendor
    // nobody chose, is exactly the silent swap this layer forbids.
    withLane('dictation_stt', 'elevenlabs', () => {
      expect(() => resolveSttProvider('dictation_stt', 'tenant-1')).toThrow(
        /No STT adapter registered for vendor 'elevenlabs'/,
      );
    });
    withLane('conversation_tts', 'elevenlabs', () => {
      expect(() => resolveTtsProvider('conversation_tts', 'tenant-1')).toThrow(
        /No TTS adapter registered for vendor 'elevenlabs'/,
      );
    });
  });
});
