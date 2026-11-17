-- Standardize 'cancelled' → 'canceled' (American spelling)
-- This migration updates all status columns that use British spelling

-- 1. pending_ownership_transfers: Update CHECK constraint and data
ALTER TABLE pending_ownership_transfers
  DROP CONSTRAINT IF EXISTS pending_ownership_transfers_status_check;

UPDATE pending_ownership_transfers
  SET status = 'canceled'
  WHERE status = 'cancelled';

ALTER TABLE pending_ownership_transfers
  ADD CONSTRAINT pending_ownership_transfers_status_check
  CHECK (status IN ('pending', 'confirmed', 'expired', 'canceled'));

-- 2. feedback_requests: Update any existing data (if table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'feedback_requests') THEN
    UPDATE feedback_requests SET status = 'canceled' WHERE status = 'cancelled';
  END IF;
END $$;

-- 3. deletion_requests: Update any existing data (if table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'deletion_requests') THEN
    UPDATE deletion_requests SET status = 'canceled' WHERE status = 'cancelled';
  END IF;
END $$;

-- 4. billing_adjustments: Update any existing data (if table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'billing_adjustments') THEN
    UPDATE billing_adjustments SET status = 'canceled' WHERE status = 'cancelled';
  END IF;
END $$;
