# KMS Module
# Per Section 20: CMEK where needed

variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "environment" {
  type = string
}

variable "project_number" {
  description = "GCP project number (for service account references)"
  type        = string
  default     = ""
}

resource "google_kms_key_ring" "main" {
  project  = var.project_id
  name     = "liftoff-${var.environment}"
  location = var.region
}

# Per Section 20: Database encryption key for Cloud SQL
resource "google_kms_crypto_key" "database" {
  name     = "database-key"
  key_ring = google_kms_key_ring.main.id

  lifecycle {
    prevent_destroy = true
  }
}

# Per Section 20: Secrets encryption key
resource "google_kms_crypto_key" "secrets" {
  name     = "secrets-key"
  key_ring = google_kms_key_ring.main.id

  lifecycle {
    prevent_destroy = true
  }
}

# Per Section 20: Artifact Registry encryption key
resource "google_kms_crypto_key" "artifact_registry" {
  name     = "artifact-registry-key"
  key_ring = google_kms_key_ring.main.id

  lifecycle {
    prevent_destroy = true
  }
}

# Per Section 20: Tenant data encryption key with automatic rotation
resource "google_kms_crypto_key" "tenant_data" {
  name     = "tenant-data-key"
  key_ring = google_kms_key_ring.main.id
  purpose  = "ENCRYPT_DECRYPT"

  # Key rotation every 90 days for compliance
  rotation_period = "7776000s" # 90 days in seconds

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  labels = {
    purpose     = "tenant-data-encryption"
    environment = var.environment
    managed-by  = "terraform"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Per Section 20: Audit logs encryption key with automatic rotation
resource "google_kms_crypto_key" "audit_logs" {
  name     = "audit-logs-key"
  key_ring = google_kms_key_ring.main.id
  purpose  = "ENCRYPT_DECRYPT"

  # Key rotation every 90 days for compliance
  rotation_period = "7776000s" # 90 days in seconds

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  labels = {
    purpose     = "audit-log-encryption"
    environment = var.environment
    managed-by  = "terraform"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Grant Cloud SQL service account permission to use database key
# Cloud SQL uses a service account in format: service-{project_number}@gcp-sa-cloud-sql.iam.gserviceaccount.com
resource "google_kms_crypto_key_iam_member" "cloud_sql" {
  count = var.project_number != "" ? 1 : 0

  crypto_key_id = google_kms_crypto_key.database.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${var.project_number}@gcp-sa-cloud-sql.iam.gserviceaccount.com"
}

# Grant Artifact Registry service account permission to use artifact registry key
# AR uses a service account in format: service-{project_number}@gcp-sa-artifactregistry.iam.gserviceaccount.com
resource "google_kms_crypto_key_iam_member" "artifact_registry" {
  count = var.project_number != "" ? 1 : 0

  crypto_key_id = google_kms_crypto_key.artifact_registry.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${var.project_number}@gcp-sa-artifactregistry.iam.gserviceaccount.com"
}

# Grant Cloud Run service account permission to use tenant data key
# Cloud Run uses a service account in format: service-{project_number}@serverless-robot-prod.iam.gserviceaccount.com
resource "google_kms_crypto_key_iam_member" "tenant_data_cloud_run" {
  count = var.project_number != "" ? 1 : 0

  crypto_key_id = google_kms_crypto_key.tenant_data.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${var.project_number}@serverless-robot-prod.iam.gserviceaccount.com"
}

# Grant Cloud Logging service account permission to use audit logs key
# Logging uses a service account in format: service-{project_number}@gcp-sa-logging.iam.gserviceaccount.com
resource "google_kms_crypto_key_iam_member" "audit_logs_logging" {
  count = var.project_number != "" ? 1 : 0

  crypto_key_id = google_kms_crypto_key.audit_logs.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${var.project_number}@gcp-sa-logging.iam.gserviceaccount.com"
}

# Grant Cloud Storage service account permission to use audit logs key (for log bucket encryption)
# Storage uses a service account in format: service-{project_number}@gs-project-accounts.iam.gserviceaccount.com
resource "google_kms_crypto_key_iam_member" "audit_logs_storage" {
  count = var.project_number != "" ? 1 : 0

  crypto_key_id = google_kms_crypto_key.audit_logs.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${var.project_number}@gs-project-accounts.iam.gserviceaccount.com"
}

output "key_ring_id" {
  value = google_kms_key_ring.main.id
}

output "key_ring_name" {
  value = google_kms_key_ring.main.name
}

output "database_key_id" {
  value = google_kms_crypto_key.database.id
}

output "database_key_name" {
  description = "Full resource name for CMEK encryption"
  value       = google_kms_crypto_key.database.id
}

output "secrets_key_id" {
  value = google_kms_crypto_key.secrets.id
}

output "artifact_registry_key_id" {
  value = google_kms_crypto_key.artifact_registry.id
}

output "artifact_registry_key_name" {
  description = "Full resource name for Artifact Registry CMEK"
  value       = google_kms_crypto_key.artifact_registry.id
}

output "tenant_data_key_id" {
  description = "Tenant data encryption key ID"
  value       = google_kms_crypto_key.tenant_data.id
}

output "tenant_data_key_name" {
  description = "Full resource name for tenant data CMEK"
  value       = google_kms_crypto_key.tenant_data.id
}

output "audit_logs_key_id" {
  description = "Audit logs encryption key ID"
  value       = google_kms_crypto_key.audit_logs.id
}

output "audit_logs_key_name" {
  description = "Full resource name for audit logs CMEK"
  value       = google_kms_crypto_key.audit_logs.id
}
