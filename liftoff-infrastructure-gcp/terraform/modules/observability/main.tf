# Observability Module
# Captures application-level logs (warnings and errors) for operational visibility
# Distinct from audit logs which capture GCP-level operations

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "bucket_location" {
  description = "Location for the storage bucket"
  type        = string
  default     = "US"
}

variable "retention_days" {
  description = "Days to retain logs before deletion"
  type        = number
  default     = 90
}

variable "log_filter" {
  description = "Cloud Logging filter for the sink"
  type        = string
  default     = "severity >= WARNING"
}

locals {
  bucket_name = "${var.project_id}-observability-logs-${var.environment}"
  sink_name   = "observability-sink"
}

# Storage bucket for application observability logs
resource "google_storage_bucket" "observability_logs" {
  project  = var.project_id
  name     = local.bucket_name
  location = var.bucket_location

  # Lifecycle rules for cost optimization
  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = var.retention_days
    }
    action {
      type = "Delete"
    }
  }

  versioning {
    enabled = false # Not needed for logs
  }

  uniform_bucket_level_access = true

  labels = {
    environment = var.environment
    purpose     = "observability-logs"
    managed_by  = "terraform"
  }
}

# Log sink for application warnings and errors
resource "google_logging_project_sink" "observability" {
  project     = var.project_id
  name        = local.sink_name
  destination = "storage.googleapis.com/${google_storage_bucket.observability_logs.name}"

  filter = var.log_filter

  unique_writer_identity = true
}

# Grant the log sink's service account permission to write to the bucket
resource "google_storage_bucket_iam_member" "observability_sink_writer" {
  bucket = google_storage_bucket.observability_logs.name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.observability.writer_identity
}

# Outputs
output "bucket_name" {
  description = "Name of the observability logs bucket"
  value       = google_storage_bucket.observability_logs.name
}

output "bucket_url" {
  description = "URL of the observability logs bucket"
  value       = google_storage_bucket.observability_logs.url
}

output "sink_name" {
  description = "Name of the log sink"
  value       = google_logging_project_sink.observability.name
}

output "sink_writer_identity" {
  description = "Service account identity for the log sink"
  value       = google_logging_project_sink.observability.writer_identity
}
