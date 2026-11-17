-- Seed the two feature-flag rows the injection detector is gated on, so the
-- detector runs at every screened ingress instead of nowhere.
--
-- FeatureFlagService.isEnabled returns false for a MISSING row, and neither key
-- has ever existed in any environment, so resolveInjectionMode was 'off' for
-- every tenant in both repos: no chat pre-filter, no tool-definition screen, no
-- persistence screen at any of its eight call sites, no trigger screen, and the
-- frameUntrusted hook screening nothing.
--
-- enabled=true on the first row puts every tenant in SHADOW: the detector runs,
-- verdicts are audited and sampled, and nothing is refused. enabled=false on the
-- second means no tenant blocks. Seeding both is also what makes the per-tenant
-- lever usable at all — setTenantOverride throws when the row is absent, which
-- is the reason migration 298 exists.
INSERT INTO feature_flags (key, name, description, enabled)
VALUES
  ('injection_detection', 'Injection detection',
   'Runs the deterministic injection detector at every screened ingress. false = off everywhere (the state before this row existed).',
   true),
  ('injection_detection_enforce', 'Injection detection enforcement',
   'With injection_detection on, a block verdict refuses at the placements PLACEMENT_MAY_BLOCK allows (chat, persistence). Tool ingress and the runtime never refuse.',
   false)
ON CONFLICT (key) DO NOTHING;
