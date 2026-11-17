-- Migration 253: add 'web_tool' to cost_attribution_events.event_type CHECK constraint.
--
-- Background: migration 173 set the CHECK constraint to a 12-value enum that
-- omits 'web_tool', but src/cost-attribution/types.ts has been declaring
-- `web_tool` as a valid EventType since the partial-unique-index rollout. The
-- typescript value mapped successfully through TS but every actual INSERT
-- failed at the partition level with:
--   new row for relation "cost_attribution_events_y<YYYY>m<MM>" violates
--   check constraint "cost_attribution_events_event_type_check"
--
-- The cost-attribution-ingest-runner and web-tool-spend-subscriber both write
-- event_type='web_tool' rows via ingestEventWithBuckets, so without this the
-- first such event fails the CHECK.

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT cost_attribution_events_event_type_check;

ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_event_type_check
    CHECK (event_type IN (
      'llm_invocation', 'embedding', 'connector_call', 'infra_compute',
      'developer_proxy_llm', 'credit', 'sandbox',
      'cloud_scheduler', 'kms_operation', 'cloud_tasks',
      'cloud_storage_op', 'cloud_build',
      'web_tool'
    ));
