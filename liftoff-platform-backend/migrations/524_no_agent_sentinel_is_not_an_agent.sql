-- The nil UUID is not an AI team, so it must not sit in a column that names one.
--
-- The tenant runtime's `agents` column is NOT NULL, so a platform assistant's
-- session — which genuinely has no AI team behind it — travels as the nil UUID.
-- The web-tool spend subscriber converted that to NULL on the way in; the
-- backstop ingester (cost-attribution/ingestion/usage-ledger-ingester.ts) went
-- through the same translator and did not, because the rule lived at one call
-- site instead of inside the translator. So the same browser session booked a
-- real agent id down the fast path and the nil UUID down the replay path.
--
-- A row like that reads as an AI team the workspace does not have, holding the
-- platform assistants' spend — the exact outcome the subscriber's comment says
-- it exists to prevent. NULL is the truthful value: the spend is the
-- workspace's, and `purpose` says which assistant made it.
--
-- The forward fix is in `toInternalAgentId` (one translator, one rule). This is
-- the history.
--
-- Idempotent and safe to re-run: it matches only rows still holding the
-- sentinel, so a second pass updates nothing. It moves no money — `agent_id` is
-- an attribution column, and `customer_cost_usd`, `ou_consumed` and
-- `cost_bucket` are untouched, so no total changes and nothing is re-billed.
-- Chargeability is unaffected: event-classification only tests
-- `agentId !== null`, and these rows were already classified when written.

-- FORCE is dropped around each write and restored immediately.
--
-- Both tables carry FORCE ROW LEVEL SECURITY and the migrate job runs as
-- liftoff_app, which has no BYPASSRLS. In a migration session
-- current_setting('app.current_tenant_id') is unset, so the policy is
-- evaluated, the statement raises, and node-pg-migrate rolls back the WHOLE
-- pending batch — every other migration in it, and every deploy queued behind
-- it. `scripts/ci-fences/migration-force-rls-fence.sh` is what says so; it
-- failed this migration before it could reach a database, which is the only
-- reason it is written correctly here.

ALTER TABLE cost_attribution_events NO FORCE ROW LEVEL SECURITY;
UPDATE cost_attribution_events
   SET agent_id = NULL
 WHERE agent_id = '00000000-0000-0000-0000-000000000000';
ALTER TABLE cost_attribution_events FORCE ROW LEVEL SECURITY;

ALTER TABLE billing_spend_events NO FORCE ROW LEVEL SECURITY;
UPDATE billing_spend_events
   SET agent_id = NULL
 WHERE agent_id = '00000000-0000-0000-0000-000000000000';
ALTER TABLE billing_spend_events FORCE ROW LEVEL SECURITY;
