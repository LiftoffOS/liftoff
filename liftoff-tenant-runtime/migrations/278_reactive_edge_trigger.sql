-- Edge-trigger for computed-metric reactive subscriptions.
--
-- Problem: computed-metric subscriptions are LEVEL-triggered — the poller
-- fires the agent on EVERY poll where the filter passes. A condition that
-- stays true (e.g. "open errors > 100" sitting at 150 for an hour) re-fires
-- the agent every poll for the whole duration — ~one LLM turn per poll, when
-- the operator expected a single notification.
--
-- Fix: make it EDGE-triggered. Fire only on a false->true transition of the
-- filter, and re-arm when it goes back to false. last_filter_passed records
-- the prior poll's filter result so the poller can detect the transition.
-- NULL = never evaluated (treated as false, so the first crossing fires).
--
-- Event-driven subscriptions (connector_event, system_event) are unaffected:
-- they fire per discrete event and already apply a per-record cooldown.

ALTER TABLE reactive_subscriptions
  ADD COLUMN IF NOT EXISTS last_filter_passed BOOLEAN;
