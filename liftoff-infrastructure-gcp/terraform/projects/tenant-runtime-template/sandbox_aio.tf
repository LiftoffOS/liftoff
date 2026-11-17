// All-in-one sandbox image (aio-sandbox) — per-tenant configuration:
// pinned image tag, KMS key for per-sandbox JWT secret envelope, runtime env vars.

variable "aio_sandbox_image_tag" {
  type        = string
  description = "Pinned tag of the all-in-one sandbox image (e.g. '2.0.3')."
  default     = "2.0.0"
}

variable "sandbox_image_registry" {
  type        = string
  description = "Artifact Registry repo URI for the aio-sandbox image. Empty = this environment's control-project sandbox-images repo."
  default     = ""
}

locals {
  sandbox_image_registry = var.sandbox_image_registry != "" ? var.sandbox_image_registry : "${var.region}-docker.pkg.dev/YOUR_GCP_PROJECT${var.environment}/sandbox-images"
}

variable "sandbox_alive_tick_ms" {
  type        = string
  description = "InstanceAliveTicker interval in milliseconds. Default 30000 (30s); clamped at runtime to [10000, 300000]. Lower = quicker entitlement reaction + smaller crash-recovery window; higher = less DB write traffic. Override per-tenant when cost-ceiling fidelity matters."
  default     = "30000"
}

# Per-tenant KMS key envelope-encrypting the SANDBOX_JWT_SECRET stored in
# sandbox_state.jwt_secret_encrypted. Per-tenant key contains blast radius.
resource "google_kms_key_ring" "sandbox_secrets" {
  name       = "sandbox-secrets"
  location   = var.region
  project    = local.project_id
  depends_on = [google_project_service.apis]
}

# The original sandbox-jwt-envelope key was tainted by a partial apply
# (mid-create failure) and Cloud Build's SA lacks
# cloudkms.cryptoKeyVersions.destroy to replace it. Drop the tainted state
# entry without destroying the GCP resource (KMS resources cannot be hard-
# deleted anyway) and create a fresh key under a new name.
removed {
  from = google_kms_crypto_key.sandbox_jwt_envelope

  lifecycle {
    destroy = false
  }
}

resource "google_kms_crypto_key" "sandbox_jwt_secret" {
  name            = "sandbox-jwt-secret"
  key_ring        = google_kms_key_ring.sandbox_secrets.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s" # 90 days
}

resource "google_kms_crypto_key_iam_member" "sandbox_jwt_encrypter_decrypter" {
  crypto_key_id = google_kms_crypto_key.sandbox_jwt_secret.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

# tool-gateway-service and agent-service (both run as the tenant-runtime SA) call
# requireSandboxJwt on /internal/sandbox/* — which loads the per-sandbox JWT
# secret from sandbox_state and KMS-decrypts it with this key. Without decrypt
# permission, every sandbox-code connector dispatch + event callback 401s with
# "SANDBOX_KMS_KEY_NAME env missing"/decrypt-denied. Decrypt-only (the runtime
# SA never encrypts; only sandbox-executor mints + envelopes new secrets above).
resource "google_kms_crypto_key_iam_member" "sandbox_jwt_decrypter_runtime" {
  crypto_key_id = google_kms_crypto_key.sandbox_jwt_secret.id
  role          = "roles/cloudkms.cryptoKeyDecrypter"
  member        = "serviceAccount:${module.iam.tenant_runtime_sa}"
}

# Cloud Run pulls the aio-sandbox image as its own per-project serverless
# robot agent (service-{project_number}@serverless-robot-prod). The image
# lives in the central platform-control project's sandbox-images repo, so
# grant the tenant's robot agent reader access cross-project. Uses the
# aliased provider because the IAM binding is on a resource owned by
# platform-control, not the tenant project.
resource "google_artifact_registry_repository_iam_member" "sandbox_images_pull" {
  provider   = google.platform_control
  project    = local.platform_control_project_id
  location   = var.region
  repository = "sandbox-images"
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:service-${google_project.tenant_runtime.number}@serverless-robot-prod.iam.gserviceaccount.com"
}

# Cloud Run ALSO validates, at *deploy* time, that the DEPLOYING identity — the
# sandbox-executor SA that makes the run.admin create() call — can read the
# image, not just the runtime robot agent above. Without this, per-sandbox
# service creation fails with a 403 "downloadArtifacts denied" before the
# container ever starts. Declared here so every tenant project in every
# environment has it, rather than relying on an out-of-band grant.
resource "google_artifact_registry_repository_iam_member" "sandbox_images_pull_deployer" {
  provider   = google.platform_control
  project    = local.platform_control_project_id
  location   = var.region
  repository = "sandbox-images"
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

# Surface the KMS key + image config to the tenant-runtime Cloud Run service.
# Cloud Run env_vars are managed in main.tf; we append here using locals so the
# author of main.tf merges these into the env block.
locals {
  sandbox_aio_env = {
    SANDBOX_IMAGE_REGISTRY = local.sandbox_image_registry
    SANDBOX_KMS_KEY_NAME   = google_kms_crypto_key.sandbox_jwt_secret.id
    AIO_SANDBOX_IMAGE_TAG  = var.aio_sandbox_image_tag
    EGRESS_POLICY_DEFAULT  = "open"
    SANDBOX_ALIVE_TICK_MS  = var.sandbox_alive_tick_ms
    # Put per-sandbox Cloud Run services on the tenant VPC (ALL_TRAFFIC egress,
    # same as the runtime services). Required so the sidecar can reach the
    # internal-ingress runtime for its callbacks (events / mcp tools / mcp
    # dispatch) — off-VPC sandboxes get an ingress-rejection HTML 404. Internet
    # egress still flows (via the VPC's Cloud NAT), so agent code is NOT
    # restricted. The provider only adds vpcAccess when these are set
    # (src/execution-environments/sandbox-vpc-access.ts).
    SANDBOX_VPC_NETWORK = google_compute_network.tenant_vpc.id
    SANDBOX_VPC_SUBNET  = google_compute_subnetwork.tenant_subnet.id
  }
}
