# audit-anchor: chain-of-custody anchor bucket for tamper-evident logs (plan 0y).
#
# Provisions:
#   - GCS bucket `audit-anchors-${env}` with 7-year object-lock
#     retention (bucket-level retention policy + event-based hold).
#   - Dedicated KMS key `audit-anchor-key` in keyring-${env}, DISTINCT
#     from each service's KMS key (plan 0y requirement).
#   - Append-only IAM: per-service SAs get roles/storage.objectCreator
#     scoped to the service's own prefix (via IAM Condition on resource.name).
#     Operators get roles/storage.objectViewer (read-only).
#   - Per-service Cloud Scheduler jobs that trigger the per-service Cloud
#     Run Job which computes the last-row SHA256 and uploads the 3-line
#     manifest: partition name, row count, SHA256.

locals {
  bucket_name = "audit-anchors-${var.environment}"
  labels = {
    service    = "audit-anchor"
    env        = var.environment
    managed_by = "terraform"
  }
}

resource "google_kms_crypto_key" "audit_anchor" {
  name            = "audit-anchor-key"
  key_ring        = var.kms_key_ring_id
  rotation_period = "7776000s"
  labels          = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_storage_bucket" "audit_anchors" {
  project                     = var.project_id
  name                        = local.bucket_name
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels

  encryption {
    default_kms_key_name = google_kms_crypto_key.audit_anchor.id
  }

  # Plan 0y: 7-year object-lock retention.
  retention_policy {
    is_locked        = var.environment == "prod"
    retention_period = 7 * 365 * 24 * 3600
  }

  versioning {
    enabled = true
  }
}

# Read on its own prefix, so a job can tell whether today's anchor already
# exists. The bucket is object-locked, which makes a same-day rewrite fail with
# 403 on storage.objects.delete rather than doing nothing — the job has to check
# before it writes, and creator alone gives write without read. Scoped to the
# same <service>/* prefix as the write grant, so this does not let one service
# read another's anchors.
resource "google_storage_bucket_iam_member" "service_read_own_prefix" {
  for_each = var.anchor_service_accounts

  bucket = google_storage_bucket.audit_anchors.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${each.value}"

  condition {
    title       = "read-${each.key}-prefix"
    description = "Restrict ${each.key} SA to reading only ${each.key}/* objects."
    expression  = "resource.name.startsWith(\"projects/_/buckets/${local.bucket_name}/objects/${each.key}/\")"
  }
}

# Append-only IAM: per-service SAs get objectCreator scoped to <service>/*.
resource "google_storage_bucket_iam_member" "service_append" {
  for_each = var.anchor_service_accounts

  bucket = google_storage_bucket.audit_anchors.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${each.value}"

  condition {
    title       = "append-${each.key}-prefix"
    description = "Restrict ${each.key} SA to writing only ${each.key}/* objects."
    expression  = "resource.name.startsWith(\"projects/_/buckets/${local.bucket_name}/objects/${each.key}/\")"
  }
}

# Operator read-only (plan 0y).
resource "google_storage_bucket_iam_member" "operator_reader" {
  for_each = toset(var.operator_readers)

  bucket = google_storage_bucket.audit_anchors.name
  role   = "roles/storage.objectViewer"
  member = each.value
}

# KMS encrypt for service SAs (so they can write new objects encrypted with
# the audit-anchor CMEK).
resource "google_kms_crypto_key_iam_member" "service_encrypt" {
  for_each = var.anchor_service_accounts

  crypto_key_id = google_kms_crypto_key.audit_anchor.id
  role          = "roles/cloudkms.cryptoKeyEncrypter"
  member        = "serviceAccount:${each.value}"
}

# GCS service agent needs encrypter/decrypter on the bucket's default KMS key
# so GCS can serve and store objects with CMEK encryption.
resource "google_kms_crypto_key_iam_member" "gcs_encrypt" {
  crypto_key_id = google_kms_crypto_key.audit_anchor.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${var.gcs_sa_email}"
}

# ─── Per-service daily anchor Cloud Scheduler jobs ───────────────────────────
# Each service owns a Cloud Run Job (scaffolded in the service's own module
# in a future PR; currently the URL is passed in via var.anchor_job_urls).
# The scheduler here fires daily 01:00 UTC, which invokes the job; the job
# computes the last-row SHA256 and uploads <service>/<yyyy-mm-dd>.hash.

resource "google_cloud_scheduler_job" "anchor" {
  for_each = var.enable_scheduler && var.scheduler_sa_email != "" ? var.anchor_job_urls : {}

  project     = var.project_id
  region      = var.region
  name        = "audit-anchor-${each.key}-${var.environment}"
  description = "Daily chain-of-custody anchor upload for ${each.key} (plan 0y)"
  schedule    = "0 1 * * *"
  time_zone   = "UTC"

  http_target {
    http_method = "POST"
    uri         = each.value

    oauth_token {
      service_account_email = var.scheduler_sa_email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "60s"
    max_backoff_duration = "600s"
  }
}

output "bucket_name" {
  value = google_storage_bucket.audit_anchors.name
}

output "kms_key_id" {
  value = google_kms_crypto_key.audit_anchor.id
}
