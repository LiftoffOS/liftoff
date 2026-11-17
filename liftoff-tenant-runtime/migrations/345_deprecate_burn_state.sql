-- Migration 345: mark burn_state deprecated. No schema change.
--
-- burn_state was the runtime's own money counter: `remaining_credits`,
-- decremented by every usage_events write and never refilled, so it is not a
-- balance. Its credits column also mixed three incompatible units in one
-- column — raw embedding input tokens, milli-USD sandbox alive-ticks, and
-- action counts — so comparing it with a dollar-shaped ceiling can deny real
-- work for a tenant that has used a tiny fraction of its OU allocation.
--
-- Spend authority is `billing_controls` plus the OU buckets in the control
-- plane, and nothing else:
--
--   * burn_state is not written by the usage ledger (recordUsage /
--     processRefund).
--   * burn_state does not gate admission or any other decision.
--   * Remaining reads are reporting only: the burn snapshot endpoint and the
--     aggregation projections.
--
-- Do not build anything new on this table.

COMMENT ON TABLE burn_state IS
  'Deprecated. Not a balance and must not gate execution: it is never refilled and its credits column mixes three units. Spend authority is the control plane (billing_controls + OU buckets). Reporting reads only.';

COMMENT ON COLUMN burn_state.remaining_credits IS
  'Deprecated. Decremented by usage and never reset, so it is not a balance.';
