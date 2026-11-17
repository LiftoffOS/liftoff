# x402 wallet treasury checks — the watch on the platform's pay-per-call
# wallet (USDC on Base, CDP server wallet; spent by connector-service, booked
# by platform-backend as cost_bucket='x402_wallet_funded').
#
# The checks are platform-backend routes armed as maintenance Cloud Tasks
# (x402-funded spend arms reload, top-up and the balance check) and run daily
# by housekeeping.tf, with the scheduler SA's identity + X-Service-Auth. Each
# answers 409 on the alert-worthy condition, so a real problem surfaces as a
# FAILED task, which maintenance_task_failed (scheduled_work_alerts.tf) pages
# on. That is why there are no per-job alert policies here.
# Both endpoints answer 200 {skipped} while X402_WALLET_ADDRESS is unset, so
# arming the schedule before funding pages nobody.
#
# The one signal the task net cannot see is connector-service refusing a
# payment (per-call cap or daily ceiling breached) — no task is
# involved. That gets its own log-based metric + alert below.

# ── connector-service refused a payment ────────────────────────────────────
#
# x402SpendGuard logs event=x402_spend_refused at ERROR when a call's 402
# demands more than the per-call cap or would cross a daily ceiling. One
# refusal can be a vendor reprice; a stream of them means either a vendor
# changed its prices across the board or something is trying to drain the
# wallet — both worth a human within the hour.
resource "google_logging_metric" "x402_spend_refused" {
  project = google_project.platform_control.project_id
  name    = "x402-spend-refused-${var.environment}"
  filter  = <<-EOT
    resource.type="cloud_run_revision"
    AND resource.labels.service_name="connector-service"
    AND severity>=ERROR
    AND jsonPayload.event="x402_spend_refused"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "x402_spend_refused" {
  project      = google_project.platform_control.project_id
  display_name = "x402 payment refused by the spend guard (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "any x402_spend_refused in 5m"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.x402_spend_refused.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = local.notification_channels

  documentation {
    content = <<-EOT
      connector-service's x402SpendGuard refused a payment: a vendor's 402
      demanded more than the per-call cap (declared price x2, floor $0.02) or
      the payment would cross a daily ceiling (X402_DAILY_CEILING_USD /
      X402_VENDOR_DAILY_CEILING_USD). Check the connector-service logs for
      the event's connectorType and amounts; a repricing vendor needs its
      declared price updated in the generated registry, a ceiling breach
      needs a look at what has been spending.
    EOT
  }
}
