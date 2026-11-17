-- Migration 499: a prepaid vendor token records who paid for it.
--
-- Every row so far was bought with the x402 wallet's USDC, and the wallet's
-- daily reconciliation subtracts those purchases from the chain side. The
-- same token can now be bought with the platform's card-funded Locus credits
-- when the wallet cannot cover the vendor's minimum (the scale-to-zero
-- fallback), and such a purchase moved no USDC of ours: counting it against
-- the chain would report drift where there is none, and the runs it pays for
-- are platform-funded, not wallet-funded. So the row carries the funder, and
-- the reconciliation and the run's funding label both read it. Existing rows
-- keep the wallet. Idempotent.

ALTER TABLE platform_prepaid_tokens
  ADD COLUMN IF NOT EXISTS funded_by VARCHAR(16) NOT NULL DEFAULT 'x402_wallet';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_prepaid_tokens_funded_by_check'
  ) THEN
    ALTER TABLE platform_prepaid_tokens
      ADD CONSTRAINT platform_prepaid_tokens_funded_by_check
      CHECK (funded_by IN ('x402_wallet', 'locus'));
  END IF;
END $$;
