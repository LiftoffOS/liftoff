// -----------------------------------------------------------------------------
// Agent-creation resilience.
//
// Two paired mechanisms:
//   1. DLQ on every control-plane subscription so poison messages cannot loop
//      indefinitely. After 10 attempts (~30 min) message routes to DLQ topic.
//   2. Cloud Monitoring alerts that page within 5 min of pipeline degradation.
//
// Also removes the legacy monolith subscriptions (Phase 7) and — after the
// Phase 5 push migration — the streaming-pull DLQ subscriber IAM grant whose
// source subscription was destroyed (`control_plane_dlq_subscriber_split`).
// -----------------------------------------------------------------------------

// Project number for Pub/Sub service-agent IAM grant.
data "google_project" "tenant_runtime_for_pubsub" {
  project_id = google_project.tenant_runtime.project_id
}

// ============================================================================
// DLQ topics + subscriptions for control-plane events
// ============================================================================

resource "google_pubsub_topic" "control_plane_dlq" {
  for_each = toset(local.control_plane_subscription_topics)

  project = google_project.tenant_runtime.project_id
  name    = "${each.value}-${var.environment}-dlq"

  message_retention_duration = "604800s" // 7 days — symmetric with main topic

  labels = {
    environment  = var.environment
    tenant_id    = var.tenant_id
    type         = "dlq"
    source_topic = each.value
  }

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription" "control_plane_dlq_sub" {
  for_each = toset(local.control_plane_subscription_topics)

  project = google_project.tenant_runtime.project_id
  name    = "${each.value}-${var.environment}-dlq-sub"
  topic   = google_pubsub_topic.control_plane_dlq[each.key].id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = "" // never expire — operator pulls via replay CLI
  }

  labels = {
    environment  = var.environment
    tenant_id    = var.tenant_id
    type         = "dlq-sub"
    source_topic = each.value
  }
}

// Pub/Sub service agent must be able to PUBLISH to each DLQ topic to forward
// expired messages from the source push subscription. The corresponding
// SUBSCRIBE grant on the source push sub (so the service agent can ack on
// behalf of the consumer) lives in pubsub_push.tf as
// `control_plane_push_subscriber`.
resource "google_pubsub_topic_iam_member" "control_plane_dlq_publisher" {
  for_each = toset(local.control_plane_subscription_topics)

  project = google_project.tenant_runtime.project_id
  topic   = google_pubsub_topic.control_plane_dlq[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.tenant_runtime_for_pubsub.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

// Phase 5 push migration: the per-subscription Pub/Sub-service-agent
// subscriber grant moved to pubsub_push.tf
// (`control_plane_push_subscriber`) where the new push subscriptions live.
// The `removed` block below destroys the old grant on next apply.
removed {
  from = google_pubsub_subscription_iam_member.control_plane_dlq_subscriber_split
  lifecycle { destroy = true }
}

// ============================================================================
// Remove the legacy monolith subs (Phase 7). The per-service split subs are
// the only active consumers; a monolith sub left in place would only
// accumulate backed-up messages until they expire.
//
// Requires Terraform >= 1.7 (see env modules' required_version pin).
// ============================================================================

removed {
  from = google_pubsub_subscription.control_plane_cross_project
  lifecycle { destroy = true }
}

removed {
  from = google_pubsub_subscription_iam_member.control_plane_subscriber
  lifecycle { destroy = true }
}

// ============================================================================
// Cloud Monitoring alerts on the control-plane event pipeline.
// Pattern matches existing alerts in main.tf (slack_bot_token gated).
// ============================================================================

locals {
  alert_notification_channels = var.slack_bot_token != "" ? [google_monitoring_notification_channel.slack[0].name] : []
}

// Alert 1: any control-plane-events sub has >5 undelivered messages for 5 min.
// Filter bridges `control-plane-events-${env}-coordinator-sub` (legacy
// streaming-pull, being destroyed by the removed{} block in main.tf during
// the Phase 5 cutover) and `control-plane-events-${env}-coordinator-push`
// (new push sub from pubsub_push.tf). Once cutover stabilizes (~1-2 weeks),
// a follow-up commit can tighten back to a single `-coordinator-push` suffix.
resource "google_monitoring_alert_policy" "control_plane_backlog" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Control-plane events: subscription backlog > 5 messages for 5 min"
  combiner     = "OR"

  conditions {
    display_name = "Undelivered messages > 5 for 5m"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=monitoring.regex.full_match(\"control-plane-events-${var.environment}(-coordinator-sub|-coordinator-push)\")"
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = local.alert_notification_channels
  alert_strategy { auto_close = "1800s" }
}

// Alert 2: oldest unacked > 10 min on any control-plane-events sub.
resource "google_monitoring_alert_policy" "control_plane_age" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Control-plane events: oldest unacked > 10 min"
  combiner     = "OR"
  conditions {
    display_name = "Oldest unacked age > 600s"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" AND resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=monitoring.regex.full_match(\"control-plane-events-${var.environment}(-coordinator-sub|-coordinator-push)\")"
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 600
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
  notification_channels = local.alert_notification_channels
  alert_strategy { auto_close = "1800s" }
}

// Alert 3: any DLQ message — there should never be any in steady state.
resource "google_monitoring_alert_policy" "control_plane_dlq_nonzero" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Control-plane events: DLQ has messages"
  combiner     = "OR"
  conditions {
    display_name = "DLQ num_undelivered_messages > 0"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.type=\"pubsub_subscription\" AND resource.labels.subscription_id=monitoring.regex.full_match(\".*-${var.environment}-dlq-sub\")"
      duration        = "60s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
  notification_channels = local.alert_notification_channels
  alert_strategy { auto_close = "1800s" }
}

// Alert 4: coordinator-service "Event handling failed" rate > 5/minute for 5 min.
// ALIGN_DELTA over 60s buckets so threshold_value is per-minute (not per-second).
resource "google_monitoring_alert_policy" "coordinator_error_rate" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Coordinator-service event handling errors > 5/minute for 5 min"
  combiner     = "OR"
  conditions {
    display_name = "Event handling failed delta > 5 per 60s for 5m"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/coordinator_event_handling_failed\" AND resource.type=\"cloud_run_revision\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
  notification_channels = local.alert_notification_channels
  alert_strategy { auto_close = "1800s" }

  depends_on = [google_logging_metric.coordinator_event_handling_failed]
}

// Custom log-based metric backing Alert 4. Filter matches the exact string at
// subscriber.ts:184 ("Event handling failed, nacking for retry"). The newer
// "Event about to be DLQ-routed" log goes through Alert 3 (DLQ nonzero) so
// it deliberately does NOT match this filter.
resource "google_logging_metric" "coordinator_event_handling_failed" {
  project = google_project.tenant_runtime.project_id
  name    = "coordinator_event_handling_failed"
  filter  = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="coordinator-service"
    severity=ERROR
    jsonPayload.message="Event handling failed, nacking for retry"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

// ----------------------------------------------------------------------------
// Reconciler drift alerts (Phase 6). These reference a custom GAUGE/DELTA
// metric `liftoff/internal_agents/drift_count` and `drift_repaired_total`
// emitted from platform-backend's reconciler (see PR-F).
//
// We pre-create the metric descriptors here so the alert policies can be
// applied BEFORE platform-backend has actually emitted any data point.
// Without these descriptors the alert-policy create call fails with
// `Cannot find metric(s) that match type ...` — a chicken-and-egg on a
// first rollout. Schema mirrors src/internal-agents/
// reconciler.ts and src/infrastructure/monitoring.ts on platform-backend.
// ----------------------------------------------------------------------------

// Platform-backend's reconciler writes drift_count and drift_repaired_total
// time series into THIS project (where the descriptors and alerts live).
// Its service account therefore needs monitoring.metricWriter here even
// though the SA itself lives in YOUR_GCP_PROJECT${var.environment}.
// Without this grant, writes fail silently with
// "7 PERMISSION_DENIED: monitoring.timeSeries.create".
resource "google_project_iam_member" "platform_backend_metric_writer" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:platform-backend-${var.environment}@YOUR_GCP_PROJECT${var.environment}.iam.gserviceaccount.com"

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_metric_descriptor" "drift_count" {
  project      = google_project.tenant_runtime.project_id
  type         = "custom.googleapis.com/liftoff/internal_agents/drift_count"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  display_name = "Internal-agent drift count"
  description  = "Number of drift events observed in the most recent reconciler pass."

  labels {
    key         = "drift_type"
    value_type  = "STRING"
    description = "Category of drift (missing_assignment, orphan, runtime_config_mismatch, ...)."
  }
  labels {
    key         = "tenant_id"
    value_type  = "STRING"
    description = "Tenant the drift belongs to (empty when scope=global)."
  }
  labels {
    key         = "scope"
    value_type  = "STRING"
    description = "global or per_tenant — alerts page on the global aggregate only."
  }

  depends_on = [google_project_service.apis]
}

// GCP custom metrics only accept GAUGE or CUMULATIVE — DELTA is rejected at
// descriptor-create time. The reconciler writes one point per pass with a
// startTime, which Cloud Monitoring treats as cumulative; the alert uses
// ALIGN_DELTA to recover per-minute rates.
resource "google_monitoring_metric_descriptor" "drift_repaired_total" {
  project      = google_project.tenant_runtime.project_id
  type         = "custom.googleapis.com/liftoff/internal_agents/drift_repaired_total"
  metric_kind  = "CUMULATIVE"
  value_type   = "INT64"
  display_name = "Internal-agent drift repaired (cumulative)"
  description  = "Cumulative count of drift events the reconciler has healed."

  labels {
    key         = "drift_type"
    value_type  = "STRING"
    description = "Category of drift that was repaired."
  }
  labels {
    key         = "tenant_id"
    value_type  = "STRING"
    description = "Tenant whose drift was repaired."
  }

  depends_on = [google_project_service.apis]
}

// Alert 4a — current drift snapshot: non-zero drift_count lasting >15 min
// (≥3 consecutive failing reconciler passes at 5-min cadence) indicates the
// reconciler CANNOT clear drift.
//
// Filter pins scope="global" so we alert on the aggregate emitted once per
// pass per drift_type. The reconciler ALSO emits scope="per_tenant" series
// for dashboard breakdowns — including those here would page on any single
// noisy tenant via REDUCE_MAX. Plan §6.7.
resource "google_monitoring_alert_policy" "agent_drift_unrepaired" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Internal-agent drift: reconciler can't clear it"
  combiner     = "OR"
  conditions {
    display_name = "drift_count > 0 for 15 min on any drift_type (global aggregate)"
    condition_threshold {
      filter          = "metric.type=\"custom.googleapis.com/liftoff/internal_agents/drift_count\" AND resource.type=\"global\" AND metric.labels.scope=\"global\""
      duration        = "900s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MAX"
        group_by_fields      = ["metric.label.drift_type"]
        cross_series_reducer = "REDUCE_MAX"
      }
    }
  }
  notification_channels = local.alert_notification_channels
  alert_strategy { auto_close = "1800s" }

  depends_on = [google_monitoring_metric_descriptor.drift_count]
}

// Alert 4b — drift repair rate: even if reconciler heals everything quickly,
// a sustained rate of healing >5/min for 30 min means the upstream pipeline is
// silently degrading.
resource "google_monitoring_alert_policy" "drift_repair_rate_high" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Reconciler healing > 5 drift events/minute for 30 min — upstream pipeline degraded"
  combiner     = "OR"
  conditions {
    display_name = "drift_repaired_total delta > 5 per 60s for 30 min"
    condition_threshold {
      filter          = "metric.type=\"custom.googleapis.com/liftoff/internal_agents/drift_repaired_total\" AND resource.type=\"global\""
      duration        = "1800s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
  notification_channels = local.alert_notification_channels
  alert_strategy { auto_close = "1800s" }

  depends_on = [google_monitoring_metric_descriptor.drift_repaired_total]
}

// ============================================================================
// Alert I — drift reconciler error count (ADR-018).
// ============================================================================
//
// runReconciliation now emits `summary.errors` as `reconciler_errors` so
// silent fetchSyncState failures (e.g., wrong runtime_url, network blip)
// trigger an alert. Descriptor + alert live here because reconciler.ts
// emits to INTERNAL_AGENT_METRICS_PROJECT_ID, set by main.tf:2642 to
// YOUR_TENANT_PROJECT${var.environment}.

resource "google_monitoring_metric_descriptor" "reconciler_errors" {
  project      = google_project.tenant_runtime.project_id
  type         = "custom.googleapis.com/liftoff/internal_agents/reconciler_errors"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  display_name = "Internal-agent reconciler tenant errors"
  description  = "Count of tenants whose reconciler pass failed (fetchSyncState threw). > 0 sustained = one or more tenants have a wrong runtime_url or a persistent connectivity issue."

  labels {
    key         = "scope"
    value_type  = "STRING"
    description = "global — single time series per pass."
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "drift_reconciler_errors" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Drift reconciler tenant errors elevated — ${var.environment}"
  combiner     = "OR"

  conditions {
    display_name = "Reconciler errors > 0 sustained 15 min"
    condition_threshold {
      filter          = "metric.type=\"custom.googleapis.com/liftoff/internal_agents/reconciler_errors\" AND resource.type=\"global\""
      duration        = "900s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = local.alert_notification_channels
  alert_strategy { auto_close = "1800s" }

  depends_on = [google_monitoring_metric_descriptor.reconciler_errors]
}

// ============================================================================
// Dashboard for the agent-creation pipeline.
// ============================================================================

resource "google_monitoring_dashboard" "agent_creation_pipeline" {
  project = google_project.tenant_runtime.project_id

  dashboard_json = jsonencode({
    displayName = "Agent Creation Pipeline"
    gridLayout = {
      columns = "2"
      widgets = [
        {
          title = "Control-plane subscription backlog"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.labels.subscription_id=monitoring.regex.full_match(\"control-plane-events-${var.environment}(-coordinator-sub|-coordinator-push)\")"
                  aggregation = {
                    alignmentPeriod  = "60s"
                    perSeriesAligner = "ALIGN_MAX"
                  }
                }
              }
            }]
          }
        },
        {
          title = "Control-plane oldest unacked age"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" AND resource.labels.subscription_id=monitoring.regex.full_match(\"control-plane-events-${var.environment}(-coordinator-sub|-coordinator-push)\")"
                  aggregation = {
                    alignmentPeriod  = "60s"
                    perSeriesAligner = "ALIGN_MAX"
                  }
                }
              }
            }]
          }
        },
        {
          title = "DLQ messages"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.labels.subscription_id=monitoring.regex.full_match(\".*-${var.environment}-dlq-sub\")"
                  aggregation = {
                    alignmentPeriod  = "60s"
                    perSeriesAligner = "ALIGN_MAX"
                  }
                }
              }
            }]
          }
        },
        {
          title = "Coordinator error rate (events/min)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"logging.googleapis.com/user/coordinator_event_handling_failed\""
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_DELTA"
                    crossSeriesReducer = "REDUCE_SUM"
                  }
                }
              }
            }]
          }
        },
        {
          title = "Drift count by type"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/liftoff/internal_agents/drift_count\""
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_MAX"
                    groupByFields      = ["metric.label.drift_type"]
                    crossSeriesReducer = "REDUCE_MAX"
                  }
                }
              }
            }]
          }
        },
      ]
    }
  })
}
