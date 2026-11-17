# R5 BE-R4-008 / Fix 12: Cloud Logging cost + chat-turn SLO alert policies.
#
# Required alerts per plan:
#   - path_traversal_blocked: page on any occurrence
#   - lock_heartbeat_failed: page if count > 3 in 10 min window
#   - lock_lost: page immediately
#   - workspace_reset_detected: count metric only
#   - stale_workspaces_remaining_count > 0: alert after 10 min sustained
#   - Cloud Logging billing: budget alert at 2x expected monthly

variable "project_id" {
  description = "GCP project ID (tenant runtime project)"
  type        = string
}

variable "notification_channels" {
  description = "PagerDuty / Slack notification channel IDs"
  type        = list(string)
}

variable "expected_monthly_logging_usd" {
  description = "Calibrated expected monthly Cloud Logging spend (see scripts/ops/calibrate-logging-cost.ts)"
  type        = number
  default     = 50
}

# ── Path traversal blocked: page on ANY occurrence ──────────────────
resource "google_monitoring_alert_policy" "path_traversal_blocked" {
  project      = var.project_id
  display_name = "R5 path_traversal_blocked (security)"
  combiner     = "OR"

  conditions {
    display_name = "any path_traversal_blocked event"
    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.event="path_traversal_blocked"
      EOT
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s" # at most one page per 5 min for path-traversal spam
    }
  }

  notification_channels = var.notification_channels
  severity              = "CRITICAL"
}

# ── Lock heartbeat failed: page if > 3 in 10 min window ──────────────
resource "google_monitoring_alert_policy" "lock_heartbeat_failed" {
  project      = var.project_id
  display_name = "R5 lock_heartbeat_failed > 3 / 10min"
  combiner     = "OR"

  conditions {
    display_name = "heartbeat failures in 10m window"
    condition_threshold {
      filter          = <<-EOT
        resource.type="cloud_run_revision"
        AND metric.type="logging.googleapis.com/user/lock_heartbeat_failed_count"
      EOT
      comparison      = "COMPARISON_GT"
      threshold_value = 3
      duration        = "600s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = var.notification_channels
  severity              = "ERROR"
}

# ── Lock lost: page immediately ──────────────────────────────────────
resource "google_monitoring_alert_policy" "lock_lost" {
  project      = var.project_id
  display_name = "R5 lock_lost (immediate page)"
  combiner     = "OR"

  conditions {
    display_name = "any lock_lost event"
    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.event="lock_lost"
      EOT
    }
  }

  notification_channels = var.notification_channels
  severity              = "CRITICAL"
}

# ── Stale workspaces remaining > 0 for 10 min ────────────────────────
resource "google_monitoring_alert_policy" "stale_workspaces_remaining" {
  project      = var.project_id
  display_name = "R5 stale workspace reaper backlog"
  combiner     = "OR"

  conditions {
    display_name = "stale_workspaces_remaining > 0 for 10min"
    condition_threshold {
      filter          = <<-EOT
        resource.type="cloud_run_revision"
        AND metric.type="logging.googleapis.com/user/reaper_remaining"
      EOT
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "600s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = var.notification_channels
  severity              = "WARNING"
}

# ── SDK contract test failure: page immediately ──────────────────────
resource "google_monitoring_alert_policy" "sdk_contract_test_failure" {
  project      = var.project_id
  display_name = "R5 sdk_contract_test_failure (P1)"
  combiner     = "OR"

  conditions {
    display_name = "any sdk_contract_test_failure event"
    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.event="sdk_contract_test_failure"
      EOT
    }
  }

  notification_channels = var.notification_channels
  severity              = "CRITICAL"
}

# ── Cloud Logging budget (2x expected monthly) ───────────────────────
resource "google_billing_budget" "logging_budget" {
  count = var.expected_monthly_logging_usd > 0 ? 1 : 0

  billing_account = data.google_billing_account.account.id
  display_name    = "R5 Cloud Logging budget (2x expected) — ${var.project_id}"

  budget_filter {
    projects = ["projects/${var.project_id}"]
    services = ["services/5490-F7B7-8DF6"] # Cloud Logging
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(ceil(var.expected_monthly_logging_usd * 2))
    }
  }

  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }
}

data "google_billing_account" "account" {
  display_name = "Liftoff Billing"
  open         = true
}
