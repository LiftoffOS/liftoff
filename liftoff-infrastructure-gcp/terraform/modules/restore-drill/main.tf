# Restore Drill Infrastructure Module
# Per Section 22 Phase 5: Restore drill automation
# Per Section 19: Quarterly restore drill
# Per Section 2: Cloud Run jobs for replay, sweeps, and maintenance

variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-west1"
}

variable "environment" {
  type = string
}

variable "source_instance_name" {
  description = "Cloud SQL instance name to test restores against"
  type        = string
}

variable "notification_channels" {
  description = "Cloud Monitoring notification channels for drill alerts"
  type        = list(string)
  default     = []
}

variable "drill_image" {
  description = "Container image for restore drill job"
  type        = string
  default     = "gcr.io/cloudrun/placeholder" # Replaced by CI/CD
}

variable "cloudsql_connections" {
  description = "Cloud SQL instance connections for drill job"
  type        = list(string)
  default     = []
}

locals {
  drill_prefix = "restore-drill-${var.environment}"
}

# Service account for restore drills
resource "google_service_account" "drill_sa" {
  project      = var.project_id
  account_id   = "${local.drill_prefix}-sa"
  display_name = "Restore Drill Service Account (${var.environment})"
  description  = "Service account for automated restore drill operations"
}

# Cloud SQL Admin permissions for drill SA
resource "google_project_iam_member" "drill_cloudsql_admin" {
  project = var.project_id
  role    = "roles/cloudsql.admin"
  member  = "serviceAccount:${google_service_account.drill_sa.email}"
}

# Storage permissions for drill reports
resource "google_project_iam_member" "drill_storage" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.drill_sa.email}"
}

# Logging permissions
resource "google_project_iam_member" "drill_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.drill_sa.email}"
}

# Cloud Run invoker permissions for drill SA (to trigger jobs)
resource "google_project_iam_member" "drill_run_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.drill_sa.email}"
}

# GCS bucket for drill reports
resource "google_storage_bucket" "drill_reports" {
  project  = var.project_id
  name     = "${var.project_id}-restore-drill-reports"
  location = var.region

  uniform_bucket_level_access = true

  lifecycle_rule {
    condition {
      age = 365 # Keep reports for 1 year
    }
    action {
      type = "Delete"
    }
  }

  versioning {
    enabled = true
  }

  labels = {
    environment = var.environment
    purpose     = "restore-drill-reports"
    managed-by  = "terraform"
  }
}

# Per Section 2: Cloud Run Job for restore drill execution
resource "google_cloud_run_v2_job" "drill_job" {
  project  = var.project_id
  name     = "${local.drill_prefix}-job"
  location = var.region

  labels = {
    environment = var.environment
    managed-by  = "terraform"
    purpose     = "restore-drill"
  }

  template {
    labels = {
      environment = var.environment
      managed-by  = "terraform"
      purpose     = "restore-drill"
    }

    parallelism = 1
    task_count  = 1

    template {
      service_account = google_service_account.drill_sa.email
      timeout         = "3600s" # 1 hour for drill operations
      max_retries     = 2

      containers {
        image = var.drill_image

        resources {
          limits = {
            cpu    = "2"
            memory = "2Gi"
          }
        }

        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }

        env {
          name  = "GCP_PROJECT"
          value = var.project_id
        }

        env {
          name  = "GCP_REGION"
          value = var.region
        }

        env {
          name  = "SOURCE_INSTANCE"
          value = var.source_instance_name
        }

        env {
          name  = "REPORTS_BUCKET"
          value = google_storage_bucket.drill_reports.name
        }

        env {
          name  = "DRILL_TYPE"
          value = "pitr"
        }
      }

      # Cloud SQL connections for the drill job
      dynamic "volumes" {
        for_each = length(var.cloudsql_connections) > 0 ? [1] : []
        content {
          name = "cloudsql"
          cloud_sql_instance {
            instances = var.cloudsql_connections
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
    ]
  }
}

# Cloud Scheduler for quarterly drills (staging only)
# Per Section 19: Quarterly restore drill
resource "google_cloud_scheduler_job" "quarterly_drill" {
  count = var.environment == "staging" ? 1 : 0

  project     = var.project_id
  region      = var.region
  name        = "${local.drill_prefix}-quarterly"
  description = "Quarterly restore drill per Section 19"
  schedule    = "0 2 1 1,4,7,10 *" # First day of Jan, Apr, Jul, Oct at 2 AM UTC
  time_zone   = "UTC"

  http_target {
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.drill_job.name}:run"
    http_method = "POST"
    headers = {
      "Content-Type" = "application/json"
    }
    body = base64encode(jsonencode({
      overrides = {
        containerOverrides = [{
          env = [
            { name = "NOTIFY_ON_SUCCESS", value = "true" },
            { name = "NOTIFY_ON_FAILURE", value = "true" },
            { name = "DRY_RUN", value = "false" },
          ]
        }]
      }
    }))

    oidc_token {
      service_account_email = google_service_account.drill_sa.email
    }
  }

  retry_config {
    retry_count          = 2
    min_backoff_duration = "30s"
    max_backoff_duration = "600s"
  }
}

# Monthly drill for more frequent testing (staging)
resource "google_cloud_scheduler_job" "monthly_drill" {
  count = var.environment == "staging" ? 1 : 0

  project     = var.project_id
  region      = var.region
  name        = "${local.drill_prefix}-monthly"
  description = "Monthly staging restore drill"
  schedule    = "0 3 1 * *" # First day of every month at 3 AM UTC
  time_zone   = "UTC"

  http_target {
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.drill_job.name}:run"
    http_method = "POST"
    headers = {
      "Content-Type" = "application/json"
    }
    body = base64encode(jsonencode({
      overrides = {
        containerOverrides = [{
          env = [
            { name = "NOTIFY_ON_SUCCESS", value = "false" },
            { name = "NOTIFY_ON_FAILURE", value = "true" },
            { name = "DRY_RUN", value = "false" },
          ]
        }]
      }
    }))

    oidc_token {
      service_account_email = google_service_account.drill_sa.email
    }
  }

  retry_config {
    retry_count          = 1
    min_backoff_duration = "60s"
    max_backoff_duration = "300s"
  }
}

# Alert policy for drill failures
resource "google_monitoring_alert_policy" "drill_failure" {
  count = length(var.notification_channels) > 0 ? 1 : 0

  project      = var.project_id
  display_name = "Restore Drill Failure Alert (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "Drill execution failed"

    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_job"
        labels.job_name="${google_cloud_run_v2_job.drill_job.name}"
        severity>=ERROR
      EOT

      label_extractors = {
        "drill_id"    = "EXTRACT(jsonPayload.drillId)"
        "environment" = "EXTRACT(jsonPayload.environment)"
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = "Restore drill failed for ${var.environment}. Check drill logs and report in ${google_storage_bucket.drill_reports.name}."
    mime_type = "text/markdown"
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s" # Alert at most once per hour
    }
  }
}

# Alert for missed quarterly drills
resource "google_monitoring_alert_policy" "missed_drill" {
  count = var.environment == "staging" && length(var.notification_channels) > 0 ? 1 : 0

  project      = var.project_id
  display_name = "Missed Quarterly Restore Drill Alert"
  combiner     = "OR"

  conditions {
    display_name = "No successful drill in 100 days"

    condition_absent {
      filter = <<-EOT
        resource.type="cloud_run_job"
        labels.job_name="${google_cloud_run_v2_job.drill_job.name}"
        jsonPayload.drillStatus="completed"
      EOT

      duration = "8640000s" # 100 days (slightly more than quarterly)

      aggregations {
        alignment_period   = "86400s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = "No successful restore drill has been recorded in the past 100 days. This violates quarterly drill requirements per Section 19."
    mime_type = "text/markdown"
  }
}

# Outputs
output "drill_service_account" {
  value = google_service_account.drill_sa.email
}

output "drill_reports_bucket" {
  value = google_storage_bucket.drill_reports.name
}

output "drill_job_name" {
  value = google_cloud_run_v2_job.drill_job.name
}

output "drill_job_uri" {
  value = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.drill_job.name}:run"
}

output "quarterly_drill_schedule" {
  value = var.environment == "staging" ? google_cloud_scheduler_job.quarterly_drill[0].schedule : "N/A"
}
