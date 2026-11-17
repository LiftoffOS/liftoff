-- 325_agent_run_states_upgrade_to_1_1
-- One-time upgrade of every legacy 1.0 agent_run_states row to the 1.1
-- engine-aware providerState shape.
--
-- WHY a data migration instead of a read-time translator: agent_run_states has
-- NO TTL (migration 113) — rows persist per invocation indefinitely — so a
-- perpetual 1.0→1.1 normalize-on-read would be forever-maintenance. Upgrading the
-- data once lets the runtime support 1.1 ONLY and fail closed on any other
-- version (run-state/service.ts load()) instead of silently coercing.
--
-- 1.0's providerState was only ever {type:'claude-agent-sdk'} (or absent); the
-- 1.1 equivalent is {engineId:'claude-agent-sdk'}, carrying no upstream
-- session/thread ids (1.0 had none). Both the JSONB `$schemaVersion` and the
-- schema_version column are advanced. Idempotent: only touches 1.0 rows. Not an
-- RLS-forced table (no tenant row-security policy), so a plain UPDATE is correct.
UPDATE agent_run_states
   SET state = jsonb_set(
                 jsonb_set(state, '{providerState}', '{"engineId":"claude-agent-sdk"}'::jsonb, true),
                 '{$schemaVersion}', '"1.1"'::jsonb, true),
       schema_version = '1.1',
       updated_at = now()
 WHERE schema_version = '1.0' OR state->>'$schemaVersion' = '1.0';
