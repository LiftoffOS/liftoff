# Phase 0s — data-subject-access orchestrator Cloud Run Job.
#
# Operators invoke the job with `gcloud run jobs execute
# data-export-orchestrator-${env} --args=...`. The job fans out to
# every service's ExportTenantData / DeleteTenantUserData RPCs,
# produces a gzipped NDJSON export in a 7-day TTL bucket, and writes
# a receipt to a 7-year retained bucket.

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

variable "image_repo" {
  type        = string
  description = "Artifact Registry repo path for the orchestrator image."
}

variable "image_sha" {
  type    = string
  default = "placeholder"
}

variable "kms_key_id" {
  type        = string
  description = "KMS key for CMEK on export + receipt buckets."
}

variable "service_account_email" {
  type        = string
  description = "SA under which the Cloud Run Job runs. Must be granted the export + receipt bucket + HMAC secret bindings."
}

locals {
  labels = {
    service    = "data-export-orchestrator"
    env        = var.environment
    managed_by = "terraform"
  }
}

resource "google_storage_bucket" "export" {
  project                     = var.project_id
  name                        = "data-exports-${var.environment}"
  location                    = var.region
  force_destroy               = var.environment != "prod"
  uniform_bucket_level_access = true
  labels                      = local.labels

  encryption {
    default_kms_key_name = var.kms_key_id
  }

  # 7-day TTL on the export objects per plan 0s.
  lifecycle_rule {
    condition { age = 7 }
    action { type = "Delete" }
  }
}

resource "google_storage_bucket" "receipts" {
  project                     = var.project_id
  name                        = "data-subject-receipts-${var.environment}"
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  labels                      = local.labels

  retention_policy {
    retention_period = 7 * 365 * 24 * 3600 # 7 years
    is_locked        = var.environment == "prod"
  }

  encryption {
    default_kms_key_name = var.kms_key_id
  }

  lifecycle_rule {
    condition { age = 7 * 365 }
    action { type = "Delete" }
  }
}

resource "google_cloud_run_v2_job" "orchestrator" {
  count    = var.image_sha != "placeholder" ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = "data-export-orchestrator-${var.environment}"

  template {
    template {
      timeout         = "3600s"
      service_account = var.service_account_email
      containers {
        image = "${var.image_repo}/data-export-orchestrator:${var.image_sha}"
        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }
        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "EXPORT_BUCKET"
          value = google_storage_bucket.export.name
        }
        env {
          name  = "RECEIPT_BUCKET"
          value = google_storage_bucket.receipts.name
        }
        env {
          name  = "HMAC_SECRET_NAME"
          value = "data-subject-access-hmac-${var.environment}"
        }
      }
    }
  }

  labels = local.labels
}

# HMAC secret shared with every callee service.
resource "google_secret_manager_secret" "hmac" {
  project   = var.project_id
  secret_id = "data-subject-access-hmac-${var.environment}"
  replication {
    user_managed {
      replicas {
        location = var.region
        customer_managed_encryption {
          kms_key_name = var.kms_key_id
        }
      }
    }
  }
  labels = local.labels
}

resource "google_secret_manager_secret_iam_member" "orchestrator_hmac_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.hmac.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.service_account_email}"

  condition {
    title       = "dsar-hmac-only-${var.environment}"
    description = "Scope orchestrator SA to the DSAR HMAC secret only (Phase 0d)."
    expression  = "resource.name.startsWith(\"projects/${var.project_id}/secrets/data-subject-access-hmac-\")"
  }
}

resource "google_storage_bucket_iam_member" "orchestrator_export_writer" {
  bucket = google_storage_bucket.export.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${var.service_account_email}"
}

resource "google_storage_bucket_iam_member" "orchestrator_receipt_writer" {
  bucket = google_storage_bucket.receipts.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${var.service_account_email}"
}

output "export_bucket" { value = google_storage_bucket.export.name }
output "receipts_bucket" { value = google_storage_bucket.receipts.name }
output "job_name" { value = var.image_sha != "placeholder" ? google_cloud_run_v2_job.orchestrator[0].name : "" }
output "hmac_secret_name" { value = google_secret_manager_secret.hmac.secret_id }
