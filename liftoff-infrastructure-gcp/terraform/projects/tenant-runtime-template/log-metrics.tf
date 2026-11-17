# WS-1.5 — Cloud Logging log-based metrics derived from the structured
# `event` field on every scrubLogger emission. Each metric is paired with
# a Cloud Monitoring alert in alerts.tf.

resource "google_logging_metric" "stub_fallback_fired" {
  project     = google_project.tenant_runtime.project_id
  name        = "stub_fallback_fired"
  description = "Count of stub-fallback log emissions. Should always be 0 after WS-2."
  filter      = "jsonPayload.event = \"stub_fallback_fired\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "tool_name"
      value_type  = "STRING"
      description = "Standard tool name that hit the fallback"
    }
  }
  label_extractors = {
    "tool_name" = "EXTRACT(jsonPayload.tool_name)"
  }
}

resource "google_logging_metric" "hitl_trust_shadow_would_clear" {
  project     = google_project.tenant_runtime.project_id
  name        = "hitl_trust_shadow_would_clear"
  description = "Count of HITL gates the trust ledger WOULD have cleared in shadow mode (decision unchanged). Backs the trust-calibration readout."
  filter      = "jsonPayload.event = \"hitl_trust_shadow_would_clear\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "tenantId"
      value_type  = "STRING"
      description = "Tenant whose agent gate would have cleared"
    }
    labels {
      key         = "actionClass"
      value_type  = "STRING"
      description = "Bare tool action class"
    }
    labels {
      key         = "gateReason"
      value_type  = "STRING"
      description = "Gate reason (level_1_gate|destructive_gate|sensitive_work|merge_to_main)"
    }
  }
  label_extractors = {
    "tenantId"    = "EXTRACT(jsonPayload.tenantId)"
    "actionClass" = "EXTRACT(jsonPayload.actionClass)"
    "gateReason"  = "EXTRACT(jsonPayload.gateReason)"
  }
}

resource "google_logging_metric" "secret_load_failed" {
  project     = google_project.tenant_runtime.project_id
  name        = "secret_load_failed"
  description = "Count of secret-load failures emitted by the secrets manifest hydrator."
  filter      = "jsonPayload.event = \"secret_load_failed\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "pool_saturation_503" {
  project     = google_project.tenant_runtime.project_id
  name        = "pool_saturation_503"
  description = "Cross-service feed endpoints returning 503 due to pool saturation."
  filter      = "jsonPayload.event = \"pool_saturation_503\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "endpoint"
      value_type = "STRING"
    }
  }
  label_extractors = {
    "endpoint" = "EXTRACT(jsonPayload.endpoint)"
  }
}

resource "google_logging_metric" "dlp_quarantine_recorded" {
  project     = google_project.tenant_runtime.project_id
  name        = "dlp_quarantine_recorded"
  description = "DLP redactor / deep-scan quarantine events."
  filter      = "jsonPayload.event = \"dlp_quarantine_recorded\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "detector"
      value_type = "STRING"
    }
  }
  label_extractors = {
    "detector" = "EXTRACT(jsonPayload.detector)"
  }
}

resource "google_logging_metric" "connector_binding_dispatchable" {
  project     = google_project.tenant_runtime.project_id
  name        = "connector_binding_dispatchable"
  description = "Per-(tenant, connector_instance) dispatchability probe outcomes."
  filter      = "jsonPayload.event = \"connector_binding_dispatchable\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "category"
      value_type = "STRING"
    }
    labels {
      key        = "ok"
      value_type = "BOOL"
    }
  }
  label_extractors = {
    "category" = "EXTRACT(jsonPayload.category)"
    "ok"       = "EXTRACT(jsonPayload.ok)"
  }
}

resource "google_logging_metric" "canary_run_outcome" {
  project     = google_project.tenant_runtime.project_id
  name        = "canary_run_outcome"
  description = "Synthetic-agent canary run outcomes."
  filter      = "jsonPayload.event = \"canary_run_outcome\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "outcome"
      value_type = "STRING"
    }
    # NOTE: do NOT add labels to this EXISTING metric — adding a label forces a
    # destroy+recreate, which deadlocks because canary_run_failed references it
    # ("Cannot delete metric … still used in an alerting policy"). Per-agent
    # diagnostics breakdown lives in the separate, additive agent_health metric.
  }
  label_extractors = {
    "outcome" = "EXTRACT(jsonPayload.outcome)"
  }
}

# NOTE: the agent_health log-metric + alert moved to platform-ci (the
# platform-control project the diagnostics JOB logs to). A metric here (tenant
# project) would never see the job's logs — cross-project.

# Invocation outcome is derived from the existing "Invocation completed"
# structured log line in agent-execution/service.ts. No new log event needed.
resource "google_logging_metric" "invocation_outcome" {
  project     = google_project.tenant_runtime.project_id
  name        = "invocation_outcome"
  description = "Invocation outcome breakdown (success/error/escalated/gated)."
  filter      = "jsonPayload.message = \"Invocation completed\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "outcome"
      value_type = "STRING"
    }
    labels {
      key        = "agent_id"
      value_type = "STRING"
    }
  }
  label_extractors = {
    "outcome"  = "EXTRACT(jsonPayload.outcome)"
    "agent_id" = "EXTRACT(jsonPayload.agent_id)"
  }
}

# VendorSdkAdapter unexpected error — the adapter raised mid-invocation
# without going through a planned terminal decision. Should be 0; any
# non-zero rate is a regression in the adapter or vendor SDK and needs
# attention before tenant agent invocations start failing.
resource "google_logging_metric" "adapter_invoke_threw" {
  project     = google_project.tenant_runtime.project_id
  name        = "adapter_invoke_threw"
  description = "VendorSdkAdapter.invoke() threw — adapter or vendor SDK regression. Should be 0."
  filter      = "jsonPayload.event = \"adapter_invoke_threw\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "invocation_id"
      value_type = "STRING"
    }
  }
  label_extractors = {
    "invocation_id" = "EXTRACT(jsonPayload.invocationId)"
  }
}

# WS-1.6 companion log-based metric for the tenant-id-unknown alert.
resource "google_logging_metric" "tenant_id_unknown" {
  project     = google_project.tenant_runtime.project_id
  name        = "tenant_id_unknown"
  description = "Log lines missing tenant attribution (should be 0 after WS-1.1/1.2)."
  filter      = "jsonPayload.tenant_id = \"unknown\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# Vendor-hosted MCP `tools/list` enumeration degraded to [] — the agent silently
# loses that server's tools for the run (non-fatal capability regression). Emitted
# as a structured log by src/agent-execution/adapter/vendor-mcp-enumerate.ts (the
# `vendor_mcp_enumerate_failed` / `_auth_failed` warn lines); reason=auth is an
# OAuth/Bearer token expiry, otherwise a transport/vendor failure. Companion alert
# in alerts.tf (google_monitoring_alert_policy.vendor_mcp_enumerate_failures).
resource "google_logging_metric" "vendor_mcp_enumerate_failed" {
  project     = google_project.tenant_runtime.project_id
  name        = "vendor_mcp_enumerate_failed"
  description = "Vendor MCP tools/list enumeration failed and degraded to [] — tools silently dropped for the run. Alert on spikes (vendor outage / token expiry)."
  filter      = "jsonPayload.message = \"vendor_mcp_enumerate_failed\" OR jsonPayload.message = \"vendor_mcp_enumerate_auth_failed\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "server_id"
      value_type = "STRING"
    }
    labels {
      key        = "reason"
      value_type = "STRING"
    }
  }
  label_extractors = {
    "server_id" = "EXTRACT(jsonPayload.serverId)"
    "reason"    = "REGEXP_EXTRACT(jsonPayload.message, \"vendor_mcp_enumerate_(auth_failed|failed)\")"
  }
}

# Dead-letter backlog in the two application tables (dlq_messages,
# failed_events). Emitted once per surface per daily sweep by
# src/infrastructure/dlq-retention.ts, and only when the count is non-zero, so
# any data point at all means there is dead-lettered work nobody has resolved.
#
# An occurrence counter, not a depth gauge. Cloud Monitoring rejects
# value_extractor on anything but a DISTRIBUTION, and turning this into one
# would buy a histogram of backlog sizes that no alert here reads: the
# threshold is zero either way. The depth and the age ride in the log entry
# (pendingCount, oldestAgeHours), which is where the responder looks, and the
# alert documentation says so.
#
# Without this neither table has a signal: rows can sit untriaged for months
# while the Pub/Sub-layer DLQ alerts next door work fine — the broker is
# watched and the application tables are not.
resource "google_logging_metric" "dlq_backlog_pending" {
  project     = google_project.tenant_runtime.project_id
  name        = "dlq_backlog_pending"
  description = "One per surface per daily sweep, emitted only when unresolved rows exist. Any data point means dead-lettered work is waiting on a person; retention never deletes these."
  filter      = "jsonPayload.event = \"dlq_backlog_pending\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "surface"
      value_type  = "STRING"
      description = "dlq_messages (the app gave up on an event) | failed_events (the drainer could not or would not republish)"
    }
  }
  label_extractors = {
    "surface" = "EXTRACT(jsonPayload.surface)"
  }
}

# The DLQ drainer refusing to republish an event again. Emitted from the
# pubsub-dlq-drainer Cloud Run Job once an event has come back from the live
# topic MAX_REPLAYS_PER_EVENT times.
#
# Without that cap this condition is unbounded and invisible: the same events
# can be republished hundreds of times each, and the only outward sign is the
# Pub/Sub DLQ-depth alert flapping every ten minutes. This metric is the deliberate end of the
# automatic path, so it should be rare and it should always be looked at.
resource "google_logging_metric" "dlq_replay_capped" {
  project     = google_project.tenant_runtime.project_id
  name        = "dlq_replay_capped"
  description = "An event hit the drainer's replay cap and will not be republished again. Held in failed_events for review."
  filter      = "jsonPayload.event = \"dlq_replay_capped\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "topic"
      value_type  = "STRING"
      description = "Live topic the event kept failing on"
    }
  }
  label_extractors = {
    "topic" = "EXTRACT(jsonPayload.topic)"
  }
}
