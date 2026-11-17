# Durable pause/resume observability, sliced by concrete execution engine.
#
# The Tenant Runtime emits the pause/resume metric family as structured logs
# (observability/runtime-extensions-metrics.ts writes one
# `{ metric_name, metric_kind, metric_value, ...labels }` entry per inc/observe).
# These log-based metrics lift that family into Cloud Monitoring so pause/resume
# health can be compared across engines — the key being that a resume rebuilds an
# adapter from CURRENT engine flags, so a flag change between pause and resume can
# resolve a different engine than the one that produced the persisted native
# artifact. The engine-mismatch guard classifies that case and falls back to the
# engine-agnostic snapshot replay; these metrics make the guard + fallback visible.
#
# All label keys are bounded closed vocabularies (see pause-resume-telemetry.ts),
# safe for metric-label cardinality.

# ── Classified pause/resume failures ────────────────────────────────────────
resource "google_logging_metric" "pause_resume_failure" {
  project     = google_project.tenant_runtime.project_id
  name        = "agent_pause_resume_failure_total"
  description = "Classified pause/resume failures sliced by engine, operation, pause kind, failure stage, failure class, and impact (terminal vs degraded)."
  filter      = "jsonPayload.metric_name = \"agent_pause_resume_failure_total\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "execution_engine"
      value_type  = "STRING"
      description = "Concrete engine the pause ran under (≤8 values; unknown-legacy for pre-provenance pauses)."
    }
    labels {
      key         = "operation"
      value_type  = "STRING"
      description = "pause | resume"
    }
    labels {
      key         = "pause_kind"
      value_type  = "STRING"
      description = "delay | ask_user | hitl_approval | delegation"
    }
    labels {
      key         = "stage"
      value_type  = "STRING"
      description = "Lifecycle boundary the failure was classified at, e.g. state_persistence | state_validation | artifact_restoration | adapter_reentry | result_delivery."
    }
    labels {
      key         = "failure_class"
      value_type  = "STRING"
      description = "Classified cause, e.g. engine_mismatch | database | malformed_state | adapter_error."
    }
    labels {
      key         = "impact"
      value_type  = "STRING"
      description = "terminal (resume aborted) | degraded (recovered via a certified fallback)."
    }
  }
  label_extractors = {
    "execution_engine" = "EXTRACT(jsonPayload.execution_engine)"
    "operation"        = "EXTRACT(jsonPayload.operation)"
    "pause_kind"       = "EXTRACT(jsonPayload.pause_kind)"
    "stage"            = "EXTRACT(jsonPayload.stage)"
    "failure_class"    = "EXTRACT(jsonPayload.failure_class)"
    "impact"           = "EXTRACT(jsonPayload.impact)"
  }
}

# ── Structured→snapshot resume fallbacks ────────────────────────────────────
resource "google_logging_metric" "resume_fallback" {
  project     = google_project.tenant_runtime.project_id
  name        = "agent_resume_fallback_total"
  description = "Certified resume fallbacks (e.g. structured session → engine-agnostic snapshot replay), sliced by engine, pause kind, and reason."
  filter      = "jsonPayload.metric_name = \"agent_resume_fallback_total\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "execution_engine"
      value_type  = "STRING"
      description = "Engine the pause ran under."
    }
    labels {
      key         = "pause_kind"
      value_type  = "STRING"
      description = "delay | ask_user | hitl_approval | delegation"
    }
    labels {
      key         = "reason"
      value_type  = "STRING"
      description = "Why the fallback happened, e.g. engine_mismatch | structured_resume_error."
    }
  }
  label_extractors = {
    "execution_engine" = "EXTRACT(jsonPayload.execution_engine)"
    "pause_kind"       = "EXTRACT(jsonPayload.pause_kind)"
    "reason"           = "EXTRACT(jsonPayload.reason)"
  }
}

# ── Pause attempt denominator ───────────────────────────────────────────────
resource "google_logging_metric" "pause_attempt" {
  project     = google_project.tenant_runtime.project_id
  name        = "agent_pause_total"
  description = "Genuine pause attempts sliced by engine, pause kind, and terminal outcome (the attempts denominator)."
  filter      = "jsonPayload.metric_name = \"agent_pause_total\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "execution_engine"
      value_type  = "STRING"
      description = "Engine the pause ran under."
    }
    labels {
      key         = "pause_kind"
      value_type  = "STRING"
      description = "delay | ask_user | hitl_approval | delegation"
    }
    labels {
      key         = "outcome"
      value_type  = "STRING"
      description = "succeeded | failed"
    }
  }
  label_extractors = {
    "execution_engine" = "EXTRACT(jsonPayload.execution_engine)"
    "pause_kind"       = "EXTRACT(jsonPayload.pause_kind)"
    "outcome"          = "EXTRACT(jsonPayload.outcome)"
  }
}

# ── Resume attempt denominator ──────────────────────────────────────────────
resource "google_logging_metric" "resume_attempt" {
  project     = google_project.tenant_runtime.project_id
  name        = "agent_resume_total"
  description = "Genuine resume attempts sliced by engine, pause kind, and terminal outcome (idempotent redeliveries excluded)."
  filter      = "jsonPayload.metric_name = \"agent_resume_total\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "execution_engine"
      value_type  = "STRING"
      description = "Engine that executed the resume."
    }
    labels {
      key         = "pause_kind"
      value_type  = "STRING"
      description = "delay | ask_user | hitl_approval | delegation"
    }
    labels {
      key         = "outcome"
      value_type  = "STRING"
      description = "succeeded | failed | degraded"
    }
  }
  label_extractors = {
    "execution_engine" = "EXTRACT(jsonPayload.execution_engine)"
    "pause_kind"       = "EXTRACT(jsonPayload.pause_kind)"
    "outcome"          = "EXTRACT(jsonPayload.outcome)"
  }
}

# ── Resume duration (signal → terminal) ─────────────────────────────────────
resource "google_logging_metric" "resume_duration" {
  project     = google_project.tenant_runtime.project_id
  name        = "agent_resume_duration_ms"
  description = "Resume latency in ms, from the resume signal to the terminal result, sliced by engine and pause kind."
  filter      = "jsonPayload.metric_name = \"agent_resume_duration_ms\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
    labels {
      key         = "execution_engine"
      value_type  = "STRING"
      description = "Engine that executed the resume."
    }
    labels {
      key         = "pause_kind"
      value_type  = "STRING"
      description = "delay | ask_user | hitl_approval | delegation"
    }
  }
  value_extractor = "EXTRACT(jsonPayload.metric_value)"
  label_extractors = {
    "execution_engine" = "EXTRACT(jsonPayload.execution_engine)"
    "pause_kind"       = "EXTRACT(jsonPayload.pause_kind)"
  }
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 20
      growth_factor      = 2
      scale              = 10
    }
  }
}

# ── Engine-sliced pause/resume dashboard ────────────────────────────────────
resource "google_monitoring_dashboard" "pause_resume" {
  project = google_project.tenant_runtime.project_id
  dashboard_json = jsonencode({
    displayName = "Pause/Resume Health (${var.environment})"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          width  = 6
          height = 4
          widget = {
            title = "Resume attempts by engine + outcome"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.resume_attempt.name}\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.execution_engine", "metric.label.outcome"]
                    }
                  }
                }
                plotType = "STACKED_BAR"
              }]
            }
          }
        },
        {
          xPos   = 6
          width  = 6
          height = 4
          widget = {
            title = "Pause/resume failures by engine + impact"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.pause_resume_failure.name}\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.execution_engine", "metric.label.impact"]
                    }
                  }
                }
                plotType = "LINE"
              }]
            }
          }
        },
        {
          yPos   = 4
          width  = 6
          height = 4
          widget = {
            title = "engine_mismatch failures (a deploy flipped engines under a live pause)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.pause_resume_failure.name}\" AND metric.label.failure_class=\"engine_mismatch\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.execution_engine"]
                    }
                  }
                }
                plotType = "LINE"
              }]
            }
          }
        },
        {
          xPos   = 6
          yPos   = 4
          width  = 6
          height = 4
          widget = {
            title = "Resume fallbacks by reason"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.resume_fallback.name}\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.reason", "metric.label.execution_engine"]
                    }
                  }
                }
                plotType = "STACKED_BAR"
              }]
            }
          }
        },
        {
          yPos   = 8
          width  = 12
          height = 4
          widget = {
            title = "Resume latency p95 by engine (ms)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.resume_duration.name}\""
                    aggregation = {
                      alignmentPeriod    = "300s"
                      perSeriesAligner   = "ALIGN_PERCENTILE_95"
                      crossSeriesReducer = "REDUCE_MAX"
                      groupByFields      = ["metric.label.execution_engine"]
                    }
                  }
                }
                plotType = "LINE"
              }]
            }
          }
        },
      ]
    }
  })
}

# ── Alerts ──────────────────────────────────────────────────────────────────

# A newly-created log-based metric's descriptor takes up to a few minutes to
# register before an alert policy can filter on its labels; without this the
# alerts race the metric and fail with a 404 on metric.label.<failure_class|impact>.
#
# A label change forces the metric to be REPLACED (destroy+recreate) — and GCP
# refuses to delete a log-metric while an alert policy still references it. So the
# sleep and both alerts are replaced together with the metric (replace_triggered_by):
# terraform then destroys the alerts BEFORE the metric and recreates them AFTER the
# sleep re-elapses, avoiding both the "still used in an alerting policy" delete error
# and the propagation 404.
resource "time_sleep" "wait_pause_resume_failure_metric" {
  depends_on      = [google_logging_metric.pause_resume_failure]
  create_duration = "60s"

  lifecycle {
    replace_triggered_by = [google_logging_metric.pause_resume_failure]
  }
}

# Terminal failures abort a resume — a genuine user-visible regression.
resource "google_monitoring_alert_policy" "pause_resume_terminal_failure" {
  depends_on = [time_sleep.wait_pause_resume_failure_metric]

  lifecycle {
    replace_triggered_by = [google_logging_metric.pause_resume_failure]
  }

  project      = google_project.tenant_runtime.project_id
  display_name = "Pause/Resume: terminal failure"
  combiner     = "OR"
  documentation {
    content = "A pause or resume failed terminally (the resume aborted rather than recovering via a certified fallback). Slice by execution_engine + failure_class on the Pause/Resume Health dashboard to find which engine regressed."
  }
  conditions {
    display_name = "terminal pause/resume failures > 0"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.pause_resume_failure.name}\" AND metric.label.impact = \"terminal\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

# Degraded engine_mismatch means a deploy changed the engine flags while a pause
# was outstanding: the resume recovered via snapshot replay, but the flag change
# should be intentional. Not user-visible, so a warning cadence, not terminal.
resource "google_monitoring_alert_policy" "pause_resume_engine_mismatch" {
  depends_on = [time_sleep.wait_pause_resume_failure_metric]

  lifecycle {
    replace_triggered_by = [google_logging_metric.pause_resume_failure]
  }

  project      = google_project.tenant_runtime.project_id
  display_name = "Pause/Resume: engine mismatch on resume (recovered)"
  combiner     = "OR"
  documentation {
    content = "A resume resolved a DIFFERENT engine than the pause ran under and fell back to the engine-agnostic snapshot replay. Expected only around an intentional engine-flag rollout with pauses in flight; a steady rate outside a rollout means flags are drifting between revisions."
  }
  conditions {
    display_name = "engine_mismatch pause/resume failures > 0"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.pause_resume_failure.name}\" AND metric.label.failure_class = \"engine_mismatch\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "600s"
      aggregations {
        alignment_period   = "600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}
