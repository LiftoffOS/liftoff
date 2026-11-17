-- Rename item_type 'ou_overage' → 'ou_usage' throughout.
--
-- 'ou_overage' was a misnomer from an earlier design that assumed a credit
-- allotment with overage pricing above it. The current model bills every OU
-- from unit 1 with no included allotment, so 'ou_usage' is the correct term.
--
-- Steps:
--   1. Relax the CHECK constraint so we can update existing rows.
--   2. Update existing subscription_items rows.
--   3. Re-add the constraint with 'ou_usage'.
--   4. Update stripe_usage_reports idempotency keys written by the old service
--      (pattern: 'ou-overage-<account_id>-<date>') so the daily dedup check
--      still finds them after the rename.

BEGIN;

-- 1. Drop old CHECK constraint on subscription_items
ALTER TABLE subscription_items
  DROP CONSTRAINT IF EXISTS subscription_items_item_type_check;

-- 2. Rename existing rows
UPDATE subscription_items
  SET item_type = 'ou_usage'
  WHERE item_type = 'ou_overage';

-- 3. Re-add CHECK constraint with updated value list
ALTER TABLE subscription_items
  ADD CONSTRAINT subscription_items_item_type_check
  CHECK (item_type IN ('platform', 'agent', 'ou_usage', 'addon'));

-- 4. Rewrite idempotency keys in stripe_usage_reports so existing daily
--    records are still matched by the updated service code.
UPDATE stripe_usage_reports
  SET stripe_idempotency_key = REPLACE(stripe_idempotency_key, 'ou-overage-', 'ou-')
  WHERE stripe_idempotency_key LIKE 'ou-overage-%';

COMMIT;
