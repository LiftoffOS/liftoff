-- Migration 010: Refunds table for Stripe refund syncing
-- Per Section 13: Sync refunds to Stripe

CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  stripe_refund_id VARCHAR(255),
  stripe_payment_intent_id VARCHAR(255),
  stripe_balance_transaction_id VARCHAR(255),
  amount INTEGER NOT NULL,
  reason VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  description TEXT,
  requested_by VARCHAR(255) NOT NULL,
  billing_period_start TIMESTAMPTZ,
  billing_period_end TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  error_message TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_refunds_tenant_id ON refunds(tenant_id);
CREATE INDEX idx_refunds_stripe_refund_id ON refunds(stripe_refund_id) WHERE stripe_refund_id IS NOT NULL;
CREATE INDEX idx_refunds_status ON refunds(status);
CREATE INDEX idx_refunds_created_at ON refunds(created_at);

-- Index for finding refunds by billing period
CREATE INDEX idx_refunds_billing_period ON refunds(tenant_id, billing_period_start, billing_period_end)
  WHERE billing_period_start IS NOT NULL;

COMMENT ON TABLE refunds IS 'Tracks refunds processed through Stripe';
COMMENT ON COLUMN refunds.amount IS 'Amount in cents';
COMMENT ON COLUMN refunds.reason IS 'duplicate, fraudulent, requested_by_customer, credit_adjustment';
COMMENT ON COLUMN refunds.status IS 'pending, succeeded, failed, requires_action';
