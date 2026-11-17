-- Migration 172: create rate_limiter_billing_internal table
-- Required by rate-limiter-flexible (RateLimiterPostgres) for billing
-- controls internal endpoints. The library auto-creates this table only if
-- the app DB user has CREATE TABLE privileges; since platform_app does not,
-- we create it here via the migrate user.

BEGIN;

CREATE TABLE IF NOT EXISTS rate_limiter_billing_internal (
  key    VARCHAR(255) NOT NULL,
  points INT          NOT NULL DEFAULT 0,
  expire BIGINT,
  CONSTRAINT rate_limiter_billing_internal_key PRIMARY KEY (key)
);

COMMIT;
