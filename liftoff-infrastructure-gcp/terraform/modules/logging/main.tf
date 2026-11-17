# Logging Module
# Per Section 18: Structured logs, Cloud Audit Logs

variable "project_id" {
  type = string
}

variable "environment" {
  type = string
}

# Log sink for long-term retention
resource "google_logging_project_sink" "audit_sink" {
  project     = var.project_id
  name        = "audit-logs-${var.environment}"
  destination = "storage.googleapis.com/${google_storage_bucket.audit_logs.name}"

  filter = "logName:\"cloudaudit.googleapis.com\""

  unique_writer_identity = true
}

resource "google_storage_bucket" "audit_logs" {
  project  = var.project_id
  name     = "${var.project_id}-audit-logs-${var.environment}"
  location = "US"

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type = "Delete"
    }
  }
}

output "audit_bucket" {
  value = google_storage_bucket.audit_logs.name
}

# -----------------------------------------------------------------------------
# Connector Payload Archive
# Per Section 12: Raw payloads are archived in Cloud Storage
# -----------------------------------------------------------------------------

resource "google_storage_bucket" "payload_archive" {
  project  = var.project_id
  name     = "${var.project_id}-payload-archive-${var.environment}"
  location = "US"

  # Per Section 21: Retention schedules by data class
  lifecycle_rule {
    condition {
      age = 90 # Keep raw payloads for 90 days
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = 365 # Delete after 1 year
    }
    action {
      type = "Delete"
    }
  }

  versioning {
    enabled = true
  }

  # Encryption at rest
  encryption {
    default_kms_key_name = var.kms_key_id
  }
}

# IAM for payload archive access
resource "google_storage_bucket_iam_member" "payload_archive_writer" {
  bucket = google_storage_bucket.payload_archive.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${var.connector_service_account}"
}

resource "google_storage_bucket_iam_member" "payload_archive_reader" {
  bucket = google_storage_bucket.payload_archive.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${var.connector_service_account}"
}

variable "kms_key_id" {
  description = "KMS key for bucket encryption"
  type        = string
  default     = ""
}

variable "connector_service_account" {
  description = "Service account for connector writes"
  type        = string
  default     = ""
}

output "payload_archive_bucket" {
  value = google_storage_bucket.payload_archive.name
}
