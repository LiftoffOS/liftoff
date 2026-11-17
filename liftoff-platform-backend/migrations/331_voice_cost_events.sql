-- Let the cost ledger hold voice usage, and hold it in the vendor's own unit.
--
-- Two changes, one migration, for one feature: voice. Only `voice_stt` is
-- written today; `voice_tts` is added alongside it because constraint values are
-- data rather than exported symbols, so an unused one costs nothing and sits
-- inertly — whereas a second ALTER of a partitioned table's CHECK, weeks later,
-- is pure avoidable risk.
--
-- Migration 253 is the cautionary tale this follows deliberately: a value such
-- as `web_tool` declared in `src/cost-attribution/types.ts` without the
-- matching CHECK value makes every INSERT fail at the partition level,
-- silently — lint passes, typecheck passes, the code is simply unreachable.
-- The TypeScript EventType change for voice ships in the same commit as this
-- file for exactly that reason.
--
-- The usage columns exist because voice vendors do not agree on a unit. TTS is
-- billed per character by ElevenLabs and by the Chirp/Standard/WaveNet Cloud
-- TTS voices, but per audio TOKEN by Gemini-TTS and by OpenAI's gpt-4o-mini-tts;
-- STT is billed per minute of audio by everyone. `input_tokens` / `output_tokens`
-- are token columns and writing characters or seconds into them would be a lie
-- that /insights and the snapshot aggregator would then read back as tokens.
--
-- This is not a precomputed convenience column. Vendor invoices are denominated
-- in characters and hours, so without the native quantity a voice equivalent of
-- src/web-tools/vendor-reconciliation.ts cannot reconcile our ledger against an
-- ElevenLabs or MiniMax bill, and a vendor price change cannot be re-costed
-- retroactively — USD alone is not invertible.
--
-- cost_attribution_events is PARTITIONED BY RANGE (occurred_at). Both ALTERs
-- target the parent and propagate to every partition; no per-partition DDL.

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT cost_attribution_events_event_type_check;

ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_event_type_check
    CHECK (event_type IN (
      'llm_invocation', 'embedding', 'connector_call', 'infra_compute',
      'developer_proxy_llm', 'credit', 'sandbox',
      'cloud_scheduler', 'kms_operation', 'cloud_tasks',
      'cloud_storage_op', 'cloud_build',
      'web_tool',
      'voice_stt', 'voice_tts'
    ));

-- Nullable: every existing row, and every non-voice row written from here on,
-- leaves both NULL. Only the voice adapters populate them.
ALTER TABLE cost_attribution_events
  ADD COLUMN IF NOT EXISTS usage_quantity NUMERIC(18,4);

ALTER TABLE cost_attribution_events
  ADD COLUMN IF NOT EXISTS usage_unit TEXT;

-- The unit vocabulary is closed on purpose: an adapter that invents a fourth
-- unit has to come through here, where the pricing module can be updated in the
-- same change. NOT VALID is unnecessary — the column is new, so every existing
-- row is NULL and NULL passes an IN-list CHECK.
ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_usage_unit_check
    CHECK (usage_unit IS NULL OR usage_unit IN ('characters', 'audio_tokens', 'audio_seconds'));

COMMENT ON COLUMN cost_attribution_events.usage_quantity IS
  'Vendor-native usage amount for this row, in usage_unit. Voice rows only today. '
  'Kept because vendor invoices are denominated in these units and USD is not invertible.';

COMMENT ON COLUMN cost_attribution_events.usage_unit IS
  'Unit for usage_quantity: characters | audio_tokens | audio_seconds.';
