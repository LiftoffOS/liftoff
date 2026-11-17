# billing: DLQ subscription + alert policy for billing-events-dlq-${env}.
#
# The DLQ topic itself is created by the pubsub-events module
# (`billing-events-${env}-dlq`). This file adds:
#   1. An operational pull subscription so on-call can inspect / replay
#      dead-lettered messages from the CLI.
#   2. A Cloud Monitoring alert policy that fires when the DLQ depth
#      exceeds 0 for more than 5 minutes (plan 0x).
#
# Wired via var.billing_events_dlq_topic_id — set in the root module
# after pubsub-events creates the DLQ topic.

# ── DLQ pull subscription (ops / replay) ─────────────────────────────────────
resource "google_pubsub_subscription" "billing_events_dlq_ops" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  name    = "billing-events-dlq-ops-${var.environment}"
  topic   = var.billing_events_dlq_topic_id

  # Long ack deadline so an on-call engineer can inspect and manually ack.
  ack_deadline_seconds       = 600
  message_retention_duration = "604800s" # 7d
  retain_acked_messages      = false

  expiration_policy {
    ttl = "" # never expire the subscription
  }

  labels = local.labels
}

# ── Alert: DLQ depth > 0 for 5 min ───────────────────────────────────────────
resource "google_monitoring_alert_policy" "billing_dlq_depth" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  display_name = "Billing DLQ depth > 0 (billing-events-dlq-${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "dlq-undelivered-messages"
    condition_threshold {
      filter = join(" ", [
        "resource.type=\"pubsub_subscription\"",
        "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\"",
        "resource.labels.subscription_id=monitoring.regex.full_match(\"billing-events-dlq-.*\")",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = "billing-events DLQ has undelivered messages — messages failed max-delivery-attempts and landed in the DLQ. Investigate with: `gcloud pubsub subscriptions pull billing-events-dlq-ops-${var.environment} --limit=10`. Runbook: docs/runbooks/billing-dlq.md"
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "604800s" # auto-close after 7d if no data
  }
}
