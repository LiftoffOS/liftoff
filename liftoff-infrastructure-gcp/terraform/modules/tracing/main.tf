# Tracing Module
# Per Section 18: Cloud Trace, OpenTelemetry instrumentation

variable "project_id" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type    = string
  default = "us-west1"
}

variable "sampling_rate" {
  description = "Trace sampling rate (0.0 to 1.0)"
  type        = number
  default     = 1.0 # 100% sampling in non-prod
}

variable "service_names" {
  description = "List of service names to configure for tracing"
  type        = list(string)
  default     = []
}

# Cloud Trace is enabled by default when the API is enabled
# This module provides configuration for trace sampling and OTel

locals {
  # Sampling rates per environment
  effective_sampling_rate = var.environment == "prod" ? 0.1 : var.sampling_rate
}

# -----------------------------------------------------------------------------
# Service Account for Trace Export
# -----------------------------------------------------------------------------

resource "google_service_account" "trace_agent" {
  project      = var.project_id
  account_id   = "trace-agent-${var.environment}"
  display_name = "Cloud Trace Agent for ${var.environment}"
}

# Grant Trace Agent role
resource "google_project_iam_member" "trace_agent" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.trace_agent.email}"
}

# Grant Metric Writer role for OTel metrics
resource "google_project_iam_member" "metric_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.trace_agent.email}"
}

# -----------------------------------------------------------------------------
# OpenTelemetry Collector Configuration (stored in Secret Manager)
# Per Section 18: OpenTelemetry instrumentation
# -----------------------------------------------------------------------------

resource "google_secret_manager_secret" "otel_config" {
  labels    = { type = "config", environment = var.environment, managed_by = "terraform" }
  project   = var.project_id
  secret_id = "otel-collector-config-${var.environment}"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "otel_config" {
  secret = google_secret_manager_secret.otel_config.id

  secret_data = yamlencode({
    receivers = {
      otlp = {
        protocols = {
          grpc = { endpoint = "0.0.0.0:4317" }
          http = { endpoint = "0.0.0.0:4318" }
        }
      }
    }

    processors = {
      batch = {
        timeout         = "1s"
        send_batch_size = 1024
      }

      memory_limiter = {
        check_interval         = "1s"
        limit_percentage       = 80
        spike_limit_percentage = 25
      }

      # Add required context fields
      attributes = {
        actions = [
          {
            key    = "environment"
            value  = var.environment
            action = "upsert"
          },
          {
            key    = "service.namespace"
            value  = "liftoff"
            action = "upsert"
          }
        ]
      }

      # Tail sampling for production
      probabilistic_sampler = {
        sampling_percentage = local.effective_sampling_rate * 100
      }
    }

    exporters = {
      googlecloud = {
        project = var.project_id

        trace = {
          # Use Cloud Trace batching
          batch = true
        }

        metric = {
          # Send to Cloud Monitoring
          instrumentation_library_labels = true
          service_resource_labels        = true
        }
      }

      logging = {
        verbosity = var.environment == "prod" ? "basic" : "detailed"
      }
    }

    extensions = {
      health_check = {}
      zpages       = { endpoint = "0.0.0.0:55679" }
    }

    service = {
      extensions = ["health_check", "zpages"]

      pipelines = {
        traces = {
          receivers  = ["otlp"]
          processors = ["memory_limiter", "attributes", "probabilistic_sampler", "batch"]
          exporters  = ["googlecloud", "logging"]
        }

        metrics = {
          receivers  = ["otlp"]
          processors = ["memory_limiter", "attributes", "batch"]
          exporters  = ["googlecloud"]
        }
      }

      telemetry = {
        logs = {
          level = var.environment == "prod" ? "warn" : "info"
        }
      }
    }
  })
}

# -----------------------------------------------------------------------------
# Alert Policies for Trace Latency
# -----------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "high_latency" {
  for_each     = toset(var.service_names)
  project      = var.project_id
  display_name = "High Latency Alert - ${each.value} (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "P99 Latency > 5s"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_latencies\" AND resource.label.\"service_name\" = \"${each.value}\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5000 # 5 seconds in ms

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MEAN"
      }
    }
  }

  notification_channels = []

  documentation {
    content   = "High P99 latency detected for ${each.value} in ${var.environment}. Check traces in Cloud Trace."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "error_rate" {
  for_each     = toset(var.service_names)
  project      = var.project_id
  display_name = "High Error Rate - ${each.value} (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "Error Rate > 5%"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.label.\"response_code_class\" = \"5xx\" AND resource.label.\"service_name\" = \"${each.value}\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.05 # 5% error rate

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = []

  documentation {
    content   = "High error rate detected for ${each.value} in ${var.environment}. Check logs and traces."
    mime_type = "text/markdown"
  }
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "trace_config" {
  value = {
    # Per Section 18: correlation IDs across every workflow/task/action/tool-call chain
    required_trace_fields = [
      "tenant_id",
      "agent_id",
      "workflow_id",
      "task_id",
      "action_id",
      "trace_id",
    ]

    # OTel configuration
    sampling_rate      = local.effective_sampling_rate
    otel_endpoint_grpc = "0.0.0.0:4317"
    otel_endpoint_http = "0.0.0.0:4318"
    trace_agent_sa     = google_service_account.trace_agent.email
  }
}

output "otel_config_secret" {
  value = google_secret_manager_secret.otel_config.name
}

output "trace_agent_service_account" {
  value = google_service_account.trace_agent.email
}
