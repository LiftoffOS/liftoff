-- Migration 491: platform_prepaid_tokens — vendor credit the x402 wallet
-- bought in advance, one row per purchase.
--
-- Apify sells its pay-per-event Actors over x402 as a PREPAID TOKEN: one
-- USDC payment on Base buys a bearer for api.apify.com whose balance is an
-- absolute spending cap, good for fourteen days, unused credit not refunded.
-- That token is a credential (it runs Actors) and a balance (it is money),
-- so it needs both custodies at once: the token itself goes to Secret
-- Manager and only its NAME is here; the money side is these columns.
--
-- One row per purchase rather than one per vendor, because the purchase is
-- the on-chain event the daily reconciliation has to explain: the wallet's
-- outflow on the purchase day is one transfer of `purchased_usd`, while the
-- ledger books the runs it funds over the following two weeks. The
-- reconciliation joins purchases by `purchased_at` to subtract them from the
-- chain side, and compares the token's own draw-down
-- (`purchased_usd - balance_usd`, read from the vendor) with the runs booked
-- against it. `balance_usd` is what the vendor last reported, never a running
-- tally of our own bookings.
--
-- The live token for a vendor is the newest row that is not retired and not
-- expired. Retirement is explicit (`retired_at` + why: expired, drained,
-- superseded) and keeps the row, so an expired token's unspent remainder
-- stays visible as the platform loss it is.
--
-- Platform-scoped like vendor_cooldowns (479): no tenant column, no RLS.
-- Reader and writer: src/billing/apify-prepaid-token-service.ts; the spender
-- is src/capability-discovery/apify-executor.ts.

CREATE TABLE IF NOT EXISTS platform_prepaid_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor          VARCHAR(64) NOT NULL,
  secret_name     VARCHAR(255) NOT NULL,
  purchased_usd   NUMERIC(12, 6) NOT NULL CHECK (purchased_usd > 0),
  balance_usd     NUMERIC(12, 6) NOT NULL CHECK (balance_usd >= 0),
  purchased_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  purchase_tx     VARCHAR(128),
  last_checked_at TIMESTAMPTZ,
  retired_at      TIMESTAMPTZ,
  retired_reason  VARCHAR(16) CHECK (retired_reason IN ('expired', 'drained', 'superseded', 'refused'))
);

CREATE INDEX IF NOT EXISTS idx_platform_prepaid_tokens_live
  ON platform_prepaid_tokens (vendor, expires_at DESC)
  WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_platform_prepaid_tokens_purchased
  ON platform_prepaid_tokens (vendor, purchased_at);
