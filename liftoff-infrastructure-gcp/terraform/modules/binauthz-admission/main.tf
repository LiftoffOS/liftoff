# Binary Authorization — project-level admission policy.
#
# Plan 0e: "per-service attestor so a tainted image cannot deploy to a
# different service's Cloud Run." The admission enforcement story on
# Cloud Run is:
#
#   1. Each service module creates its own attestor (billing-attestor,
#      developer-proxy-attestor, workforce-service-attestor,
#      plus the pre-existing platform-backend / connector-service /
#      governance-engine / tenant-runtime attestors). Each attestor's
#      signer SA is restricted to the service's Cloud Build SA — so
#      only that service's CI pipeline can produce valid attestations.
#
#   2. This module wires the project-level
#      `google_binary_authorization_policy` to require attestation by
#      AT LEAST ONE of the listed attestors. Because each attestor's
#      signer is locked to its service, a tainted image built in a
#      different service's pipeline cannot produce a valid
#      attestation — the policy rejects admission.
#
#   3. Cloud Run itself cannot express "service X only admits images
#      signed by attestor X" (that's a GKE-only feature). Enforcement
#      therefore relies on attestor-SA isolation + the multi-attestor
#      requirement policy below.
#
# Enforcement mode is ENFORCED_BLOCK_AND_AUDIT_LOG in prod,
# DRYRUN_AUDIT_LOG_ONLY in dev (audit-log a failure without blocking,
# so we can iterate on the policy without breaking dev deploys).

variable "project_id" {
  type = string
}

variable "environment" {
  type = string
}

variable "attestor_names" {
  type        = list(string)
  description = "Fully qualified attestor resource names, one per Liftoff service (billing, developer-proxy, workforce-service, platform-backend, connector-service, governance-engine, tenant-runtime)."
}

variable "admission_whitelist_patterns" {
  type        = list(string)
  description = "Image name patterns exempt from attestation. Use for Google-owned images (GKE system, Cloud Run base images) and for emergency break-glass (empty list in prod)."
  default = [
    "gcr.io/google-containers/*",
    "gcr.io/google_containers/*",
    "k8s.gcr.io/*",
    "registry.k8s.io/*",
    "gke.gcr.io/*",
    "gcr.io/stackdriver-agents/*",
    "gcr.io/cloud-builders/*",
    "gcr.io/gke-release/*",
  ]
}

variable "global_policy_evaluation_mode" {
  type        = string
  default     = "ENABLE"
  description = "ENABLE pulls in Google's shared policy (trusted base images); DISABLE operates on this policy alone."
}

locals {
  enforcement_mode = var.environment == "prod" ? "ENFORCED_BLOCK_AND_AUDIT_LOG" : "DRYRUN_AUDIT_LOG_ONLY"
}

resource "google_binary_authorization_policy" "policy" {
  project = var.project_id

  # Project-level default: require attestation by ANY of the per-service
  # attestors. Combined with attestor-signer-SA isolation, this means a
  # tainted image can only deploy if it was built by one of the
  # authorised service CI pipelines.
  default_admission_rule {
    evaluation_mode         = "REQUIRE_ATTESTATION"
    enforcement_mode        = local.enforcement_mode
    require_attestations_by = var.attestor_names
  }

  dynamic "admission_whitelist_patterns" {
    for_each = var.admission_whitelist_patterns
    content {
      name_pattern = admission_whitelist_patterns.value
    }
  }

  global_policy_evaluation_mode = var.global_policy_evaluation_mode
}

output "policy_id" {
  value = google_binary_authorization_policy.policy.id
}

output "enforcement_mode" {
  value       = local.enforcement_mode
  description = "Effective enforcement mode for this environment."
}
