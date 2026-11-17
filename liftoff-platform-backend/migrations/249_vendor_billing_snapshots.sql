CREATE TABLE vendor_billing_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor TEXT NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  billing_period TEXT NOT NULL,
  credits_used INTEGER NOT NULL,
  total_credits INTEGER NOT NULL,
  cost_limit_usd NUMERIC,
  raw_response JSONB NOT NULL,
  UNIQUE (vendor, billing_period)
);
