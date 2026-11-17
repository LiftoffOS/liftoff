-- Chain-depth bound for self-scheduled follow-ups.
--
-- Problem: an agent can call schedule_followup to re-schedule itself. Because
-- replace-semantics keep exactly one pending row per (tenant, agent,
-- context_ref), a steady self-loop (run -> schedule 1 -> run -> ...) never
-- approaches the 5000 pending-quota — it can loop indefinitely, bounded only
-- by the tenant's credit balance. The quota only bounds fan-out, not loops.
--
-- Fix: track a chain_depth (generation count) on each scheduled row. A
-- follow-up scheduled BY a self-scheduled execution inherits depth+1;
-- schedule_followup rejects past a configurable max (default 10). This is the
-- industry-standard recursion/iteration limit; admission credits remain the
-- ultimate budget backstop.
--
-- depth 0 = scheduled by a non-self-scheduled execution (human/cron/event).

ALTER TABLE agent_scheduled_invocations
  ADD COLUMN IF NOT EXISTS chain_depth INT NOT NULL DEFAULT 0;
