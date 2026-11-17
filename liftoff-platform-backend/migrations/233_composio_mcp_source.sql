-- Add 'composio_mcp' as a new EventSource for cost_attribution_events.
--
-- Composio-managed connectors (gong, microsoft_dynamics, square,
-- google_ads, cal_com, mailchimp, trello, freshbooks, discord, airtable,
-- typeform) dispatch tool calls directly from tenant-runtime to
-- Composio's MCP server — connector-service is never in the data path,
-- so the existing `governance` / `tenant_runtime` sources don't fit.
-- A dedicated source value lets per-source dashboards and the
-- bucket-allocation pipeline treat Composio's per-call meter as a
-- distinct cost stream.
--
-- The event_type stays `connector_call` — a Composio tool call IS a
-- connector call from the cost-ledger perspective; no new event_type
-- value needed.
--
-- Constraint lives on the parent partitioned table; PostgreSQL propagates
-- the change to every monthly partition automatically.

ALTER TABLE cost_attribution_events
  DROP CONSTRAINT cost_attribution_events_source_check;

ALTER TABLE cost_attribution_events
  ADD CONSTRAINT cost_attribution_events_source_check
    CHECK (source IN (
      'tenant_runtime', 'governance', 'developer_proxy',
      'gcp_billing', 'gcp_billing_platform', 'platform_llm',
      'composio_mcp'
    ));
