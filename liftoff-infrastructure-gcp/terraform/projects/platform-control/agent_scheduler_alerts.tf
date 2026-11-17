# Alert policies for the four-layer agent-scheduler observability stack.
# Notification channels are shared across the module via local.notification_channels
# (computed in main.tf from var.slack_bot_token).

# Alert policy: missing schedulers (an active+cron agent without an enabled job).
resource "google_monitoring_alert_policy" "agent_scheduler_missing" {
  project      = google_project.platform_control.project_id
  display_name = "Agent scheduler missing"
  combiner     = "OR"

  conditions {
    display_name = "missing_count > 0 for 1 hour"
    condition_threshold {
      filter          = "metric.type=\"custom.googleapis.com/agent_scheduler/missing_count\" resource.type=\"global\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "3600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = local.notification_channels
}

resource "google_monitoring_alert_policy" "agent_scheduler_paused" {
  project      = google_project.platform_control.project_id
  display_name = "Agent scheduler paused unexpectedly"
  combiner     = "OR"

  conditions {
    display_name = "paused_count > 0 for 1 hour"
    condition_threshold {
      filter          = "metric.type=\"custom.googleapis.com/agent_scheduler/paused_count\" resource.type=\"global\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "3600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
  notification_channels = local.notification_channels
}

resource "google_monitoring_alert_policy" "agent_scheduler_failing" {
  project      = google_project.platform_control.project_id
  display_name = "Agent scheduler last-attempt failing"
  combiner     = "OR"

  conditions {
    display_name = "failing_count > 0 for 30 min"
    condition_threshold {
      filter          = "metric.type=\"custom.googleapis.com/agent_scheduler/failing_count\" resource.type=\"global\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "1800s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
  notification_channels = local.notification_channels
}

# Layer C — reconciler liveness alert.
# Fires if the reconciler stops emitting metrics for ANY tenant project,
# meaning the reconciler is dead end-to-end. Cannot be silenced by the
# reconciler itself because the alert is on metric ABSENCE.
resource "google_monitoring_alert_policy" "reconciler_liveness" {
  project      = google_project.platform_control.project_id
  display_name = "Canonical reconciler stopped emitting metrics (Layer C)"
  combiner     = "OR"
  conditions {
    display_name = "no metric writes in 30 min"
    condition_absent {
      # resource.type restriction is required by the Cloud Monitoring API
      # for all alert filters, even when the metric_type uniquely identifies
      # the series. All Layer A/B writes use resource.type="global".
      filter   = "metric.type=\"custom.googleapis.com/agent_scheduler/missing_count\" metric.labels.source=\"reconciler\" resource.type=\"global\""
      duration = "1800s" # 30 min ≈ 6 missed reconciler ticks
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }
  notification_channels = local.notification_channels
}

# Layer C (auditor half) — auditor liveness.
#
# The reconciler half above has existed since this stack was built; the auditor
# had no equivalent, and its filter (metric.labels.source="reconciler") meant it
# could never stand in for one. That asymmetry is why agent-scheduler-audit
# could fail 129 times running without a single alert: Layer C watched the
# source that was working, and Layer D reported agreement because a missing
# operand scores 0.
#
# Watches the unconditional heartbeat rather than a per-tenant metric, so it
# stays correct in an environment with no cron agents.
resource "google_monitoring_alert_policy" "auditor_liveness" {
  project      = google_project.platform_control.project_id
  display_name = "Central auditor stopped emitting metrics (Layer C — auditor)"
  combiner     = "OR"
  conditions {
    display_name = "no auditor heartbeat in 3 hours"
    condition_absent {
      filter = "metric.type=\"custom.googleapis.com/agent_scheduler/auditor_heartbeat\" resource.type=\"global\""
      # The auditor is hourly, not 5-minutely like the reconciler, so 30 min
      # would flap on a single slow run. Three missed hours is unambiguous.
      duration = "10800s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }
  notification_channels = local.notification_channels

  depends_on = [time_sleep.agent_scheduler_metrics_propagate]
}

# The audit ran but could not see part of the estate. Distinct from liveness:
# the job exits 0 and looks healthy, and before this metric existed the only
# trace was a log line nobody alerts on.
resource "google_monitoring_alert_policy" "auditor_partial" {
  project      = google_project.platform_control.project_id
  display_name = "Central auditor could not reach a tenant project"
  combiner     = "OR"
  conditions {
    display_name = "auditor_unreachable_count > 0 for 2 hours"
    condition_threshold {
      filter          = "metric.type=\"custom.googleapis.com/agent_scheduler/auditor_unreachable_count\" resource.type=\"global\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "7200s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
  notification_channels = local.notification_channels

  depends_on = [time_sleep.agent_scheduler_metrics_propagate]
}

# One source stopped reporting, so Layer D's diff for those tenants is not a
# comparison at all. Without this, an absent source reads as agreement.
resource "google_monitoring_alert_policy" "agent_scheduler_source_absent" {
  project      = google_project.platform_control.project_id
  display_name = "Reconciler/auditor cross-check has only one source"
  combiner     = "OR"
  conditions {
    display_name = "source_absent_count > 0 for 2 hours"
    condition_threshold {
      filter          = "metric.type=\"custom.googleapis.com/agent_scheduler/source_absent_count\" resource.type=\"global\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "7200s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["metric.label.source", "metric.label.kind"]
      }
    }
  }
  notification_channels = local.notification_channels

  depends_on = [time_sleep.agent_scheduler_metrics_propagate]
}

# Layer D — cross-check alert.
# Standard threshold on the disagreement_count metric written by the
# disagreement-emitter Cloud Run Job. >0 means reconciler and auditor
# disagreed for a (tenant, kind) pair — one of them is lying.
resource "google_monitoring_alert_policy" "agent_scheduler_cross_check" {
  project      = google_project.platform_control.project_id
  display_name = "Reconciler ↔ auditor disagreement (Layer D)"
  combiner     = "OR"
  conditions {
    display_name = "disagreement_count > 0 for 30 min"
    condition_threshold {
      filter          = "metric.type=\"custom.googleapis.com/agent_scheduler/disagreement_count\" resource.type=\"global\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "1800s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
  notification_channels = local.notification_channels
}
