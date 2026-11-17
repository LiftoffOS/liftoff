CREATE TABLE token_buckets (
  bucket_key TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL,
  capacity DOUBLE PRECISION NOT NULL,
  refill_rate_per_sec DOUBLE PRECISION NOT NULL,
  last_refilled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
