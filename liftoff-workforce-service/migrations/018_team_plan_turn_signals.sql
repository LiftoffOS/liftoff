-- Migration 018: the other half of mid-run control — steering a live turn.
--
-- Migration 016 let a person STOP the Chief AI Officer mid-turn. This lets them
-- redirect it: a message typed while the reply is streaming is folded into the
-- turn already running instead of starting a second one on the same thread.
--
-- Stop needed no table of its own because it is one bit per turn, and 016 put
-- that bit on the claim row. A message is not one bit — it has content, a
-- sender, and an order relative to other messages — so it gets rows, addressed
-- to the turn that must answer them.
--
-- Addressed by turn_id, never by thread. A message that arrives too late to be
-- consumed therefore cannot be picked up by the NEXT turn on the same thread,
-- which would answer something the person sent minutes ago in a conversation
-- that has moved on. It does not linger either: turn_id is a foreign key onto
-- the claim row, so a signal dies with the turn it was addressed to. There is
-- no sweeper to schedule and no way to accumulate orphans.

BEGIN;

-- The claim row is keyed by thread_id; the foreign key below needs turn_id to
-- be unique in its own right. Turn ids are minted per turn (randomUUID), so
-- this constraint costs nothing and can never fail on existing rows.
ALTER TABLE team_plan_active_turns
  ADD CONSTRAINT team_plan_active_turns_turn_id_key UNIQUE (turn_id);

CREATE TABLE team_plan_turn_signals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id     UUID NOT NULL
                REFERENCES team_plan_active_turns (turn_id) ON DELETE CASCADE,
  -- Only 'user_message' today. Stop travels on the claim row (016) because it
  -- is a bit, not a message; the kind is here so a second kind of delivery
  -- (a system continuation, say) widens a CHECK rather than adding a table.
  signal_kind VARCHAR(64) NOT NULL CHECK (signal_kind IN ('user_message')),
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Consumption IS the claim: the loop marks a row consumed in the same
  -- statement that reads it, so two boundary polls cannot both deliver it.
  consumed_at TIMESTAMPTZ
);

-- The loop's boundary poll: pending signals for one turn, oldest first. The
-- partial index keeps it to the handful of rows actually waiting.
CREATE INDEX idx_team_plan_turn_signals_pending
  ON team_plan_turn_signals (turn_id, created_at)
  WHERE consumed_at IS NULL;

-- Supports the cascade: without it, deleting a claim row sequentially scans the
-- signals table looking for children.
CREATE INDEX idx_team_plan_turn_signals_turn
  ON team_plan_turn_signals (turn_id);

-- Signals carry no tenant column: tenancy is resolved through the claim row
-- that owns the turn, the same shape team_plan_messages uses to inherit it from
-- its thread (migration 012). Referential actions run as the table owner, so
-- the cascade above is unaffected by this policy.
ALTER TABLE team_plan_turn_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY team_plan_turn_signals_tenant_isolation ON team_plan_turn_signals
  USING (
    turn_id IN (
      SELECT turn_id FROM team_plan_active_turns
      WHERE tenant_id = current_setting('app.current_tenant_id', true)::uuid
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON team_plan_turn_signals TO workforce_app;

COMMIT;
