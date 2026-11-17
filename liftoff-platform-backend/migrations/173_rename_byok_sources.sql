-- Rename byok source values to developer_proxy in cost_attribution_events.
--
-- Rows with the old source values are not expected, because this rename runs
-- before the developer-proxy service takes traffic. The UPDATE is included for
-- completeness and safety.

-- Update any rows with old source values
UPDATE cost_attribution_events SET event_type = 'developer_proxy_llm' WHERE event_type = 'byok_llm';
UPDATE cost_attribution_events SET source = 'developer_proxy' WHERE source = 'byok_proxy';

-- Drop the old CHECK constraints and recreate them with the new values.
-- The constraints live on the parent partitioned table; PostgreSQL propagates
-- them to all partitions automatically.

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT cost_attribution_events_event_type_check;

ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_event_type_check
    CHECK (event_type IN (
      'llm_invocation', 'embedding', 'connector_call', 'infra_compute',
      'developer_proxy_llm', 'credit', 'sandbox',
      'cloud_scheduler', 'kms_operation', 'cloud_tasks',
      'cloud_storage_op', 'cloud_build'
    ));

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT cost_attribution_events_source_check;

ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_source_check
    CHECK (source IN (
      'tenant_runtime', 'governance', 'developer_proxy',
      'gcp_billing', 'gcp_billing_platform', 'platform_llm'
    ));

-- Update the cursor row in cost_attribution_cursors if it exists
UPDATE cost_attribution_cursors SET source = 'developer_proxy' WHERE source = 'byok_proxy';
