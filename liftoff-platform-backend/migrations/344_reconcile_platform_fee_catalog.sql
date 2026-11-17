-- 344: bring platform_fee_catalog and accounts.headcount to what migration 140 now says.
--
-- WHY THIS EXISTS. Migration 140 was rewritten in place after it had first been applied.
-- node-pg-migrate never re-runs a migration it has already recorded, so the rewrite reaches
-- no database that already ran it. Such a database carries the ORIGINAL 140 --
-- platform_fee_catalog with min_workers / max_workers / price_cents and workers_* tier
-- keys, and no accounts.headcount -- while a from-scratch rebuild produces the rewritten
-- shape. The row that records 140 as applied is true of the file's first
-- version and false of its current one, and nothing anywhere compares the two.
--
-- The deployed code expects the rewritten shape. resolvePlatformFeeTier() selects
-- min_headcount / max_headcount / price_per_headcount_cents, and
-- POST /api/internal/billing/accounts/:accountId/headcount opens with
-- UPDATE accounts SET headcount = $2. Both raise 42703 against the original shape.
-- That stays hidden until the endpoint is called, and while the platform fee sits at
-- its placeholder of 0 no operator has a reason to set a headcount.
--
-- The fix is forward and idempotent, the way 163 did it for item_type -- never by editing
-- an applied migration. On a from-scratch
-- rebuild every statement below is a no-op, because 140 already produced this shape.
--
-- Nothing reads the OLD names: no src query names min_workers, max_workers or
-- platform_fee_catalog.price_cents, and no code hardcodes a tier key. So this narrows a
-- divergence and cannot widen one.

-- ── accounts.headcount ────────────────────────────────────────────────────────
-- Read by subscription-items-service, written by the CS headcount endpoint.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS headcount INTEGER NOT NULL DEFAULT 0;

-- ── platform_fee_catalog column names ─────────────────────────────────────────
-- RENAME COLUMN has no IF EXISTS, so each rename is guarded on the old name still
-- being present. Guarding on the OLD name (rather than the absence of the new one)
-- keeps each rename independent, so a half-applied state still converges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'platform_fee_catalog'
                AND column_name = 'min_workers') THEN
    ALTER TABLE platform_fee_catalog RENAME COLUMN min_workers TO min_headcount;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'platform_fee_catalog'
                AND column_name = 'max_workers') THEN
    ALTER TABLE platform_fee_catalog RENAME COLUMN max_workers TO max_headcount;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'platform_fee_catalog'
                AND column_name = 'price_cents') THEN
    ALTER TABLE platform_fee_catalog RENAME COLUMN price_cents TO price_per_headcount_cents;
  END IF;
END $$;

-- ── tier keys and display names ───────────────────────────────────────────────
-- subscription_items.platform_fee_tier_key is a FK to platform_fee_catalog(tier_key)
-- declared without ON UPDATE CASCADE, so renaming a key that a row points at would fail.
-- There may be zero such rows, but this drops the constraint and re-adds it rather
-- than trusting that, so parent and children move together and this stays
-- correct whenever it runs. Deferring the constraint instead does NOT work: restoring it
-- to NOT DEFERRABLE in the same transaction raises "cannot ALTER TABLE ... because it has
-- pending trigger events" as soon as a row is actually on the FK -- which passes on
-- zero rows and fails the first time one exists. Dropping and re-adding is what 163 does,
-- and it leaves the constraint byte-identical to the one 140 declares inline.
ALTER TABLE subscription_items
  DROP CONSTRAINT IF EXISTS subscription_items_platform_fee_tier_key_fkey;

UPDATE platform_fee_catalog
   SET tier_key = 'headcount_' || substring(tier_key FROM 9)
 WHERE tier_key LIKE 'workers\_%';

UPDATE subscription_items
   SET platform_fee_tier_key = 'headcount_' || substring(platform_fee_tier_key FROM 9)
 WHERE platform_fee_tier_key LIKE 'workers\_%';

-- Re-adding validates every existing row, so an incomplete remap fails here rather than
-- leaving a dangling reference behind.
ALTER TABLE subscription_items
  ADD CONSTRAINT subscription_items_platform_fee_tier_key_fkey
  FOREIGN KEY (platform_fee_tier_key) REFERENCES platform_fee_catalog(tier_key);

UPDATE platform_fee_catalog SET name = 'Starter (1–20)'      WHERE tier_key = 'headcount_0_20';
UPDATE platform_fee_catalog SET name = 'Growth (21–100)'     WHERE tier_key = 'headcount_20_100';
UPDATE platform_fee_catalog SET name = 'Scale (101–500)'     WHERE tier_key = 'headcount_100_500';
UPDATE platform_fee_catalog SET name = 'Enterprise (501+)'   WHERE tier_key = 'headcount_500_plus';

-- ── the placeholder Stripe price ──────────────────────────────────────────────
-- 140's rewritten seed stamps the SAME placeholder price id on all four tiers, and
-- classifySubscriptionItem() resolves a tier with
--   SELECT tier_key FROM platform_fee_catalog WHERE stripe_price_id = $1 LIMIT 1
-- so on a fresh environment that lookup returns an arbitrary one of the four. Clearing the
-- placeholder converges every database on the honest state -- not priced until a real price
-- is set per tier -- and removes the ambiguous match instead of propagating it.
UPDATE platform_fee_catalog
   SET stripe_price_id = NULL
 WHERE stripe_price_id = 'price_YOUR_STRIPE_ID';
