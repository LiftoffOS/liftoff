# Audit Module
# Per Section 16 and 19: Cloud Audit Logs with retention policies and compliance evidence

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "log_bucket_name" {
  description = "Name for the audit log bucket"
  type        = string
  default     = ""
}

variable "bigquery_dataset_id" {
  description = "BigQuery dataset ID for audit log export"
  type        = string
  default     = ""
}

variable "kms_key_id" {
  description = "KMS key ID for encryption"
  type        = string
  default     = ""
}

variable "retention_days" {
  description = "Retention period in days for audit logs"
  type        = number
  default     = 365 # 1 year default for compliance
}

variable "enable_bigquery_export" {
  description = "Enable BigQuery export for audit analytics"
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "Email for compliance alerts"
  type        = string
  default     = ""
}

locals {
  log_bucket_name = var.log_bucket_name != "" ? var.log_bucket_name : "audit-logs-${var.project_id}-${var.environment}"

  # Per Section 19: Services requiring enhanced audit logging
  sensitive_services = [
    "cloudsql.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "storage.googleapis.com",
  ]

  # Retention periods by data class (per Section 19 GDPR requirements)
  retention_config = {
    dev     = 30
    staging = 90
    prod    = var.retention_days
  }

  effective_retention = lookup(local.retention_config, var.environment, 365)
}

# ==========================================
# Enable Data Access Audit Logs
# ==========================================

resource "google_project_iam_audit_config" "all_services" {
  project = var.project_id
  service = "allServices"

  audit_log_config {
    log_type = "ADMIN_READ"
  }

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

# Enhanced audit logging for sensitive services
resource "google_project_iam_audit_config" "sensitive_services" {
  for_each = toset(local.sensitive_services)

  project = var.project_id
  service = each.value

  audit_log_config {
    log_type = "ADMIN_READ"
  }

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

# ==========================================
# Log Storage Bucket
# ==========================================

resource "google_storage_bucket" "audit_logs" {
  project  = var.project_id
  name     = local.log_bucket_name
  location = "US"

  # Per Section 19: Retention policy for compliance
  retention_policy {
    is_locked        = var.environment == "prod"
    retention_period = local.effective_retention * 24 * 60 * 60 # Convert days to seconds
  }

  # Versioning for audit trail integrity
  versioning {
    enabled = true
  }

  # Lifecycle rules
  lifecycle_rule {
    condition {
      age = local.effective_retention + 30 # Buffer period
    }
    action {
      type = "Delete"
    }
  }

  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  # Encryption
  dynamic "encryption" {
    for_each = var.kms_key_id != "" ? [1] : []
    content {
      default_kms_key_name = var.kms_key_id
    }
  }

  uniform_bucket_level_access = true

  labels = {
    environment = var.environment
    purpose     = "audit-logs"
    compliance  = "soc2"
  }
}

# ==========================================
# Log Sinks
# ==========================================

# Sink for admin activity logs
resource "google_logging_project_sink" "admin_activity" {
  project     = var.project_id
  name        = "audit-admin-activity-${var.environment}"
  destination = "storage.googleapis.com/${google_storage_bucket.audit_logs.name}"

  filter = <<-EOT
    logName:"cloudaudit.googleapis.com%2Factivity"
  EOT

  unique_writer_identity = true
}

# Sink for data access logs
resource "google_logging_project_sink" "data_access" {
  project     = var.project_id
  name        = "audit-data-access-${var.environment}"
  destination = "storage.googleapis.com/${google_storage_bucket.audit_logs.name}"

  filter = <<-EOT
    logName:"cloudaudit.googleapis.com%2Fdata_access"
  EOT

  unique_writer_identity = true
}

# Sink for system events
resource "google_logging_project_sink" "system_events" {
  project     = var.project_id
  name        = "audit-system-events-${var.environment}"
  destination = "storage.googleapis.com/${google_storage_bucket.audit_logs.name}"

  filter = <<-EOT
    logName:"cloudaudit.googleapis.com%2Fsystem_event"
  EOT

  unique_writer_identity = true
}

# Sink for security-critical events (IAM, Secret Manager, KMS)
resource "google_logging_project_sink" "security_events" {
  project     = var.project_id
  name        = "audit-security-events-${var.environment}"
  destination = "storage.googleapis.com/${google_storage_bucket.audit_logs.name}"

  filter = <<-EOT
    protoPayload.serviceName=("iam.googleapis.com" OR "secretmanager.googleapis.com" OR "cloudkms.googleapis.com")
    AND (protoPayload.methodName:("SetIamPolicy" OR "Create" OR "Delete" OR "Update" OR "Access"))
  EOT

  unique_writer_identity = true
}

# Grant write access to the log sinks
resource "google_storage_bucket_iam_member" "admin_activity_writer" {
  bucket = google_storage_bucket.audit_logs.name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.admin_activity.writer_identity
}

resource "google_storage_bucket_iam_member" "data_access_writer" {
  bucket = google_storage_bucket.audit_logs.name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.data_access.writer_identity
}

resource "google_storage_bucket_iam_member" "system_events_writer" {
  bucket = google_storage_bucket.audit_logs.name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.system_events.writer_identity
}

resource "google_storage_bucket_iam_member" "security_events_writer" {
  bucket = google_storage_bucket.audit_logs.name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.security_events.writer_identity
}

# ==========================================
# BigQuery Export (for audit analytics)
# ==========================================

resource "google_bigquery_dataset" "audit_logs" {
  count = var.enable_bigquery_export ? 1 : 0

  project    = var.project_id
  dataset_id = var.bigquery_dataset_id != "" ? var.bigquery_dataset_id : "audit_logs_${var.environment}"
  location   = "US"

  default_table_expiration_ms = local.effective_retention * 24 * 60 * 60 * 1000

  labels = {
    environment = var.environment
    purpose     = "audit-analytics"
  }
}

resource "google_logging_project_sink" "bigquery_export" {
  count = var.enable_bigquery_export ? 1 : 0

  project     = var.project_id
  name        = "audit-bigquery-export-${var.environment}"
  destination = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.audit_logs[0].dataset_id}"

  filter = <<-EOT
    logName:"cloudaudit.googleapis.com"
  EOT

  unique_writer_identity = true

  bigquery_options {
    use_partitioned_tables = true
  }
}

resource "google_bigquery_dataset_iam_member" "sink_writer" {
  count = var.enable_bigquery_export ? 1 : 0

  project    = var.project_id
  dataset_id = google_bigquery_dataset.audit_logs[0].dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.bigquery_export[0].writer_identity
}

# ==========================================
# Compliance Monitoring Alerts
# ==========================================

# Alert for unauthorized IAM changes
resource "google_monitoring_alert_policy" "iam_changes" {
  count = var.alert_email != "" && var.environment == "prod" ? 1 : 0

  project      = var.project_id
  display_name = "Unauthorized IAM Policy Changes"

  combiner = "OR"

  conditions {
    display_name = "IAM Policy Modified"

    condition_matched_log {
      filter = <<-EOT
        protoPayload.serviceName="iam.googleapis.com"
        AND protoPayload.methodName="SetIamPolicy"
        AND NOT protoPayload.authenticationInfo.principalEmail:("gserviceaccount.com")
      EOT

      label_extractors = {
        "principal" = "EXTRACT(protoPayload.authenticationInfo.principalEmail)"
        "resource"  = "EXTRACT(protoPayload.resourceName)"
      }
    }
  }

  notification_channels = []

  alert_strategy {
    auto_close = "604800s" # 7 days
  }

  documentation {
    content   = "An IAM policy was modified by a non-service account. Review the change for compliance."
    mime_type = "text/markdown"
  }
}

# Alert for Secret Manager access
resource "google_monitoring_alert_policy" "secret_access" {
  count = var.alert_email != "" && var.environment == "prod" ? 1 : 0

  project      = var.project_id
  display_name = "Sensitive Secret Access"

  combiner = "OR"

  conditions {
    display_name = "Secret Accessed"

    condition_matched_log {
      filter = <<-EOT
        protoPayload.serviceName="secretmanager.googleapis.com"
        AND protoPayload.methodName="AccessSecretVersion"
      EOT

      label_extractors = {
        "principal" = "EXTRACT(protoPayload.authenticationInfo.principalEmail)"
        "secret"    = "EXTRACT(protoPayload.resourceName)"
      }
    }
  }

  notification_channels = []

  alert_strategy {
    notification_rate_limit {
      period = "3600s" # Once per hour
    }
    auto_close = "604800s"
  }

  documentation {
    content   = "A secret was accessed. This is logged for compliance purposes."
    mime_type = "text/markdown"
  }
}

# ==========================================
# Outputs
# ==========================================

output "audit_enabled" {
  description = "Whether audit logging is enabled"
  value       = true
}

output "audit_bucket_name" {
  description = "Name of the audit log storage bucket"
  value       = google_storage_bucket.audit_logs.name
}

output "audit_bucket_url" {
  description = "URL of the audit log storage bucket"
  value       = google_storage_bucket.audit_logs.url
}

output "retention_days" {
  description = "Audit log retention period in days"
  value       = local.effective_retention
}

output "bigquery_dataset_id" {
  description = "BigQuery dataset ID for audit analytics"
  value       = var.enable_bigquery_export ? google_bigquery_dataset.audit_logs[0].dataset_id : null
}

output "log_sinks" {
  description = "List of log sink names"
  value = {
    admin_activity  = google_logging_project_sink.admin_activity.name
    data_access     = google_logging_project_sink.data_access.name
    system_events   = google_logging_project_sink.system_events.name
    security_events = google_logging_project_sink.security_events.name
  }
}
