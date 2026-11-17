-- 309: goal ledger for invariant reactive subscriptions.
--
-- An invariant subscription (source_kind='computed_metric', source_spec.mode
-- ='invariant') asserts that a polled predicate should ALWAYS hold. The
-- computed-metric poller evaluates it every cycle. Unlike an opportunity
-- subscription — which EDGE-fires an agent on false→true — an invariant
-- ESCALATES to a human when the predicate goes FALSE (satisfied→violated) and
-- records the outcome of EVERY check here so operators have an audit trail of
-- when the invariant held and when it broke.
--
-- Append-only: one row per poll per invariant subscription. `escalated` marks
-- the checks that actually triggered a HITL escalation (the satisfied→violated
-- edge); persistently-violated checks re-append status='violated' with
-- escalated=false so the ledger shows continuous breach without re-escalating
-- (mirrors reactive_subscriptions.last_filter_passed edge logic).

CREATE TABLE goal_ledger (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  UUID NOT NULL REFERENCES reactive_subscriptions(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL,
  agent_id         UUID NOT NULL,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  value            NUMERIC,                       -- extracted metric value; NULL if non-finite
  status           TEXT NOT NULL CHECK (status IN ('satisfied', 'violated')),
  escalated        BOOLEAN NOT NULL DEFAULT FALSE,-- true only on the satisfied→violated edge
  escalation_id    UUID                           -- workflow_escalations.id when escalated
);

-- Per-invariant history, newest first (ledger read / "when did it break?").
CREATE INDEX idx_goal_ledger_sub ON goal_ledger (subscription_id, checked_at DESC);
-- Per-tenant reporting.
CREATE INDEX idx_goal_ledger_tenant ON goal_ledger (tenant_id, checked_at DESC);
