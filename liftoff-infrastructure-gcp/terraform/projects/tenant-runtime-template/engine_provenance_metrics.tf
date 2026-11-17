# Engine-sliced invocation observability.
#
# Log-based metric derived from the structured `engine_invocation_completed`
# event (Tenant Runtime: invocations/service.ts completeInvocation) so Cloud
# Monitoring can slice invocation outcomes by the (engine, provider) PAIR.
# Neither half is enough alone: `provider` cannot tell OpenAI-Agents from Codex
# or GenAI from ADK from the Gemini CLI, and `execution_engine` cannot tell
# opencode serving Grok from opencode serving an open-weights model, which are
# different backends with different failure modes. Paired with an alert that
# fires when a NEW invocation still completes as `unknown-legacy`: post
# migration 321 every active revision writes a concrete engine, so a non-zero
# unknown-legacy rate means a revision predating provenance or an unrecognized
# provider. Both labels are bounded (≤10 engines × ≤12 providers), safe for
# metric-label cardinality.

resource "google_logging_metric" "engine_invocation_completed" {
  project     = google_project.tenant_runtime.project_id
  name        = "engine_invocation_completed"
  description = "Invocation completions sliced by concrete execution engine, provider + outcome."
  filter      = "jsonPayload.event = \"engine_invocation_completed\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "execution_engine"
      value_type  = "STRING"
      description = "Concrete engine: claude-agent-sdk | openai-agents | openai-codex | google-genai | google-adk | google-gemini-cli | openrouter-openai-wire | xai-openai-wire | opencode | unknown-legacy."
    }
    labels {
      key         = "provider"
      value_type  = "STRING"
      description = "The provider the invocation resolved to (invocations.provider): anthropic | anthropic-vertex | openai | google | xai | glm | qwen | deepseek | kimi | minimax | unknown."
    }
    labels {
      key         = "outcome"
      value_type  = "STRING"
      description = "success | error | escalated"
    }
  }
  label_extractors = {
    "execution_engine" = "EXTRACT(jsonPayload.executionEngine)"
    "provider"         = "EXTRACT(jsonPayload.provider)"
    "outcome"          = "EXTRACT(jsonPayload.outcome)"
  }
}

// Engine-sliced dashboard — compares invocation volume
// and outcome across concrete engines during a controlled rollout, plus the
// unknown-legacy watch. Derived from the engine_invocation_completed log metric
// so it auto-populates as engines run.
resource "google_monitoring_dashboard" "engine_provenance" {
  project = google_project.tenant_runtime.project_id
  dashboard_json = jsonencode({
    displayName = "Engine Provenance (${var.environment})"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          width  = 6
          height = 4
          widget = {
            title = "Invocations by (engine, provider)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.engine_invocation_completed.name}\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.execution_engine", "metric.label.provider"]
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
            title = "Error rate by (engine, provider)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.engine_invocation_completed.name}\" AND metric.label.outcome=\"error\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["metric.label.execution_engine", "metric.label.provider"]
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
          width  = 12
          height = 4
          widget = {
            title = "unknown-legacy invocations (should be 0 post-321)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.engine_invocation_completed.name}\" AND metric.label.execution_engine=\"unknown-legacy\""
                    aggregation = {
                      alignmentPeriod  = "300s"
                      perSeriesAligner = "ALIGN_SUM"
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

# A newly-created log-based metric's descriptor takes up to a few minutes to
# register before an alert policy can filter on its labels; without this the
# alert races the metric and fails with a 404 on metric.label.execution_engine.
#
# Both this wait and the alert below are REPLACED whenever the metric changes.
# The provider cannot edit a metric descriptor's labels in place, so a new
# label replaces the metric — and the API refuses to delete a metric an alert
# policy still reads. Tying the alert's lifetime to the metric's makes the
# order destroy alert → destroy metric → create metric → wait → create alert,
# which is the only order the API accepts.
resource "time_sleep" "wait_engine_invocation_completed_metric" {
  depends_on      = [google_logging_metric.engine_invocation_completed]
  create_duration = "60s"

  lifecycle {
    replace_triggered_by = [google_logging_metric.engine_invocation_completed]
  }
}

resource "google_monitoring_alert_policy" "engine_unknown_legacy_invocation" {
  depends_on = [time_sleep.wait_engine_invocation_completed_metric]

  lifecycle {
    replace_triggered_by = [google_logging_metric.engine_invocation_completed]
  }

  project      = google_project.tenant_runtime.project_id
  display_name = "Engine provenance: unknown-legacy on a new invocation"
  combiner     = "OR"

  documentation {
    content = "A NEW invocation completed with execution_engine=unknown-legacy. After migration 321 every active revision should write a concrete engine; investigate a revision that predates provenance or a provider the resolver does not recognize."
  }

  conditions {
    display_name = "unknown-legacy engine completions > 0"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.engine_invocation_completed.name}\" AND metric.label.execution_engine = \"unknown-legacy\""
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
