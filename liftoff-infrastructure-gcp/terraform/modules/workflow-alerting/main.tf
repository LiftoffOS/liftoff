# Workflow Alerting Module
# Phase 6 alert policies for workflow security, validation, catalog, and DLQ metrics.

# -----------------------------------------------------------------------------
# 1. Security counter — any security.* metric → page
# -----------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "security_event" {
  count        = length(var.notification_channels) > 0 ? 1 : 0
  project      = var.project_id
  display_name = "Workflow Security Event (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "Security metric logged"
    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        resource.labels.service_name="platform-backend"
        jsonPayload.metric=~"security\\."
      EOT
      label_extractors = {
        "metric"   = "EXTRACT(jsonPayload.metric)"
        "tenantId" = "EXTRACT(jsonPayload.tenantId)"
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = <<-EOT
      ## Workflow Security Event Alert

      A security-related metric was emitted by the platform backend. This could indicate:
      - Prompt injection detected in distill input
      - Workflow steps hash mismatch (possible tampering)
      - HITL floor bypass attempt

      **Immediate Actions:**
      1. Check the metric type and tenant ID in the alert labels
      2. Follow your workflow incident response runbook
      3. Consider pausing the affected agent if hash mismatch is detected

      **Severity:** HIGH — any security counter firing warrants investigation.
    EOT
    mime_type = "text/markdown"
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
  }
}

# -----------------------------------------------------------------------------
# 2. Workflow validation rejection rate → warning
# -----------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "workflow_validation_rejected" {
  count        = length(var.notification_channels) > 0 ? 1 : 0
  project      = var.project_id
  display_name = "High Workflow Validation Rejection Rate (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "Workflow validation rejections detected"
    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        resource.labels.service_name="platform-backend"
        jsonPayload.metric="workflow.validation.rejected"
      EOT
      label_extractors = {
        "reason"   = "EXTRACT(jsonPayload.reason)"
        "tenantId" = "EXTRACT(jsonPayload.tenantId)"
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = <<-EOT
      ## Workflow Validation Rejection Alert

      Multiple workflow validation rejections detected. This may indicate:
      - LLM hallucinating tool names not in the catalog
      - Catalog stale or unreachable
      - Systematic prompt issues

      **Actions:**
      1. Check which tenants are affected (tenantId label)
      2. Review rejection reasons (reason label)
      3. Verify tool catalog endpoint is responsive
    EOT
    mime_type = "text/markdown"
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
  }
}

# -----------------------------------------------------------------------------
# 3. Catalog lookup failure rate → warning
# -----------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "catalog_lookup_failure" {
  count        = length(var.notification_channels) > 0 ? 1 : 0
  project      = var.project_id
  display_name = "High Catalog Lookup Failure Rate (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "Catalog fetch failures detected"
    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        resource.labels.service_name="platform-backend"
        jsonPayload.metric="catalog_fetch_failed"
        severity>=WARNING
      EOT
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = <<-EOT
      ## Catalog Lookup Failure Alert

      Tool catalog fetches are failing. Distill will gracefully degrade to agent-type
      classification (no workflows possible without tool catalog).

      **Actions:**
      1. Check tenant-runtime health and connectivity
      2. Verify the tool-catalog endpoint is responding
      3. Check for network/firewall issues between platform-backend and tenant-runtime
    EOT
    mime_type = "text/markdown"
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
  }
}

# -----------------------------------------------------------------------------
# 4. DLQ depth > 10 → page (internal_agent_events)
# -----------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "agent_events_dlq" {
  count        = length(var.notification_channels) > 0 ? 1 : 0
  project      = var.project_id
  display_name = "Internal Agent Events DLQ Backlog (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "DLQ undelivered messages > 10"
    condition_threshold {
      filter          = <<-EOT
        resource.type = "pubsub_subscription"
        AND resource.labels.subscription_id = "internal-agent-events-${var.environment}-dlq-sub"
        AND metric.type = "pubsub.googleapis.com/subscription/num_undelivered_messages"
      EOT
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = <<-EOT
      ## Internal Agent Events DLQ Backlog

      More than 10 messages are stuck in the internal agent events dead-letter queue.
      This means agent lifecycle events (created, status_changed, runtime_config_updated)
      are not being processed by the tenant runtime.

      **Actions:**
      1. Check tenant-runtime subscriber health
      2. Inspect DLQ messages: `gcloud pubsub subscriptions pull internal-agent-events-${var.environment}-dlq-sub --limit=10`
      3. Check for schema mismatches or subscriber crashes
      4. Follow your workflow incident response runbook
    EOT
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "604800s"
  }
}
