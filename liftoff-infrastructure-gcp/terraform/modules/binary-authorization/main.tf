# Binary Authorization Module
# Per Section 20: Binary Authorization for trusted deploys

variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "region" {
  description = "Region for KMS keyring"
  type        = string
}

variable "environment" {
  description = "Environment name"
  type        = string
}

variable "enforcement_mode" {
  description = "Enforcement mode: ENFORCED_BLOCK_AND_AUDIT_LOG or DRYRUN_AUDIT_LOG_ONLY. Defaults based on environment."
  type        = string
  default     = null # When null, will be determined by environment
}

variable "require_attestation" {
  description = "Whether to require attestation. Per Section 20, defaults to true for prod."
  type        = bool
  default     = null # When null, will be determined by environment
}

variable "allowed_signer_service_accounts" {
  description = "Service accounts allowed to sign attestations"
  type        = list(string)
  default     = []
}

locals {
  # Per Section 20: Binary Authorization enforced for production
  effective_enforcement_mode = var.enforcement_mode != null ? var.enforcement_mode : (
    var.environment == "prod" ? "ENFORCED_BLOCK_AND_AUDIT_LOG" : "DRYRUN_AUDIT_LOG_ONLY"
  )
  effective_require_attestation = var.require_attestation != null ? var.require_attestation : (
    var.environment == "prod"
  )
}

# KMS Keyring for attestation signing
resource "google_kms_key_ring" "attestation" {
  project  = var.project_id
  name     = "attestation-keyring-${var.environment}"
  location = var.region
}

# Asymmetric signing key for attestations
resource "google_kms_crypto_key" "attestation" {
  name     = "attestation-key-${var.environment}"
  key_ring = google_kms_key_ring.attestation.id
  purpose  = "ASYMMETRIC_SIGN"

  version_template {
    algorithm        = "EC_SIGN_P256_SHA256"
    protection_level = "SOFTWARE"
  }

  # Rotate annually
  rotation_period = "31536000s"

  lifecycle {
    prevent_destroy = true
  }
}

# Get crypto key version for attestor
data "google_kms_crypto_key_version" "attestation" {
  crypto_key = google_kms_crypto_key.attestation.id
}

# Container Analysis Note
resource "google_container_analysis_note" "build" {
  project = var.project_id
  name    = "build-attestation-${var.environment}"

  attestation_authority {
    hint {
      human_readable_name = "Build Attestor for ${var.environment}"
    }
  }
}

# Binary Authorization Attestor
resource "google_binary_authorization_attestor" "build" {
  project = var.project_id
  name    = "build-attestor-${var.environment}"

  attestation_authority_note {
    note_reference = google_container_analysis_note.build.name

    public_keys {
      id = data.google_kms_crypto_key_version.attestation.id
      pkix_public_key {
        public_key_pem      = data.google_kms_crypto_key_version.attestation.public_key[0].pem
        signature_algorithm = data.google_kms_crypto_key_version.attestation.public_key[0].algorithm
      }
    }
  }
}

# Service account for signing attestations
resource "google_service_account" "attestor_signer" {
  project      = var.project_id
  account_id   = "attestor-signer-${var.environment}"
  display_name = "Attestation Signer for ${var.environment}"
}

# Grant signing permission on KMS key
resource "google_kms_crypto_key_iam_member" "attestor_signer" {
  crypto_key_id = google_kms_crypto_key.attestation.id
  role          = "roles/cloudkms.signerVerifier"
  member        = "serviceAccount:${google_service_account.attestor_signer.email}"
}

# Grant note attacher permission
resource "google_container_analysis_note_iam_member" "attestor_signer" {
  project = var.project_id
  note    = google_container_analysis_note.build.name
  role    = "roles/containeranalysis.notes.attacher"
  member  = "serviceAccount:${google_service_account.attestor_signer.email}"
}

# Allow specified service accounts to impersonate the signer
resource "google_service_account_iam_member" "impersonate" {
  for_each           = toset(var.allowed_signer_service_accounts)
  service_account_id = google_service_account.attestor_signer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${each.value}"
}

# Binary Authorization Policy
# Per Section 20: Binary Authorization for trusted deploys
resource "google_binary_authorization_policy" "policy" {
  project = var.project_id

  default_admission_rule {
    evaluation_mode         = local.effective_require_attestation ? "REQUIRE_ATTESTATION" : "ALWAYS_ALLOW"
    enforcement_mode        = local.effective_enforcement_mode
    require_attestations_by = local.effective_require_attestation ? [google_binary_authorization_attestor.build.name] : null
  }

  # Global policy - applies to all clusters
  global_policy_evaluation_mode = "ENABLE"
}

output "attestor_name" {
  value = google_binary_authorization_attestor.build.name
}

output "attestor_signer_email" {
  value = google_service_account.attestor_signer.email
}

output "attestation_key_id" {
  value = google_kms_crypto_key.attestation.id
}

output "attestation_key_version_id" {
  value = data.google_kms_crypto_key_version.attestation.id
}
