-- 254 — Fix the alias-pattern bug from migration 252.
--
-- Migration 252 used `WHERE alias NOT LIKE '%-________'` to skip rows
-- that were already in the per-account format. The pattern means
-- "anything followed by hyphen followed by exactly 8 characters."
-- That correctly identifies rows like `google-mail-1a2b3c4d` as
-- already-migrated.
--
-- Bug: it ALSO matches connector aliases whose type happens to have
-- exactly one hyphen with exactly 8 characters after it. The only
-- connector type that fits this shape is `google_calendar`, which
-- becomes `google-calendar` after the `_`→`-` replacement, and
-- `calendar` is exactly 8 chars. So migration 252 skips every
-- `google-calendar` manifest, leaving them in the legacy single-alias
-- format, while every other type is rewritten correctly.
--
-- Migration 058's partial unique index is gone (252 dropped it) so the
-- inconsistency isn't catastrophic — the catalog builder still works.
-- But if google_calendar reconnects in the future, the handler will
-- INSERT a fresh row with alias `google-calendar-<idshort>`, leaving
-- two manifest rows for the same connector (one with the legacy alias,
-- one with the per-account alias). The catalog would then expose two
-- google_calendar tool sets to the LLM. Fix proactively.
--
-- The corrected pattern matches "anything ending in hyphen + exactly 8
-- hex chars" — `[0-9a-f]{8}` is what manifest aliases use for the
-- connector_id discriminator. UUIDs only use 0-9 and a-f, so this
-- pattern can't false-positive against any real connector type name
-- (no connector_type contains hex-only 8-char words after a hyphen).

UPDATE connector_manifests
SET alias = REPLACE(connector_type, '_', '-')
              || '-'
              || SUBSTRING(id::text, 1, 8),
    updated_at = NOW()
WHERE alias !~ '-[0-9a-f]{8}$';

UPDATE action_allowlists aa
SET connector = REPLACE(m.connector_type, '_', '-')
                  || '-'
                  || SUBSTRING(m.id::text, 1, 8)
FROM connector_manifests m
WHERE aa.tenant_id = m.tenant_id
  AND aa.connector = REPLACE(m.connector_type, '_', '-')   -- legacy single-alias form
  AND m.alias = REPLACE(m.connector_type, '_', '-')
                  || '-'
                  || SUBSTRING(m.id::text, 1, 8);          -- post-this-migration form

-- Sanity check: same shape as migration 252's, but using the tighter
-- hex-only suffix regex.
DO $$
DECLARE
  legacy_count INT;
BEGIN
  SELECT COUNT(*) INTO legacy_count
  FROM connector_manifests
  WHERE alias !~ '-[0-9a-f]{8}$';
  IF legacy_count > 0 THEN
    RAISE EXCEPTION 'Migration 254: % manifest(s) still carry a legacy single-alias format. Investigate before proceeding.', legacy_count;
  END IF;
END $$;
