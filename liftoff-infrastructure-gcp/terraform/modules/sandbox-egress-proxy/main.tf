# sandbox-egress-proxy — Envoy audit sidecar for tenant sandbox execution containers.
#
# BACKGROUND
# ----------
# Agents run arbitrary Python/Node.js code inside sandbox-executor Cloud Run
# containers (gen2/gVisor, see projects/tenant-runtime-template/main.tf). Those
# containers make direct outbound HTTP/HTTPS calls to vendor APIs (Salesforce,
# Slack, Google, etc.) that completely bypass the audit pipeline — no pre-action
# snapshot, no before/after state.
#
# This module provisions the supporting infrastructure for a transparent Envoy
# proxy sidecar injected alongside sandbox containers. All outbound HTTP/HTTPS
# traffic is intercepted at the network layer regardless of which HTTP library
# the agent code uses, because sandbox containers are configured with:
#   HTTP_PROXY=http://localhost:9901
#   HTTPS_PROXY=http://localhost:9901
#
# PROXY BEHAVIOUR
# ---------------
# 1. Logs every outbound request (domain, method, URL, status, latency).
# 2. For write verbs (POST/PUT/PATCH/DELETE) to known vendor domains: makes a
#    preflight GET to capture pre-action state before forwarding.
# 3. Emits structured audit events to the control-plane-events-{env} Pub/Sub
#    topic using the sandbox-executor SA identity.
# 4. Provider-agnostic: works with any HTTP client in the sandbox.
# 5. Correlates events to invocations via X-Liftoff-Invocation-Id header that
#    the sandbox wrapper injects into all outbound calls.
#
# WHAT THIS MODULE OWNS
# ---------------------
# - GCS bucket (sandbox-proxy-config-<tenant>-<env>) to store envoy.yaml
# - GCS object upload of envoy-config/envoy.yaml from this module directory
# - IAM: storage.objectViewer on the bucket for sandbox-executor SA (to mount)
# - IAM: pubsub.publisher on the cross-project control-plane-events-{env} topic
#
# WHAT THIS MODULE DOES NOT OWN
# ------------------------------
# The Cloud Run service resource itself (google_cloud_run_v2_service.sandbox_executor)
# is NOT managed here. It lives in projects/tenant-runtime-template/main.tf.
# The reason: extracting that resource into a module would require moving it
# in state, which causes an unnecessary destroy-and-recreate of the Cloud Run
# service. Instead, the caller (tenant-runtime-template) adds the audit-proxy
# container and env vars directly to that resource, referencing this module's
# outputs for the bucket name and topic ID.
#
# See projects/tenant-runtime-template/sandbox_egress_proxy.tf for the actual
# Cloud Run container additions.
#
# PROVIDER COMPATIBILITY NOTE
# ---------------------------
# This module uses google_storage_bucket_object which is stable in google ~> 5.x.
# The cloud_storage volume mount used in the Cloud Run template (see
# sandbox_egress_proxy.tf in the tenant-runtime-template project) requires
# google >= 5.25 for full schema support. If applying against an older provider
# pinned to ~> 5.0, use lifecycle.ignore_changes on template[0].volumes and
# template[0].containers[1].volume_mounts (same pattern as split_services.tf).

locals {
  bucket_name     = var.proxy_config_bucket != "" ? var.proxy_config_bucket : "sandbox-proxy-config-${var.tenant_id}-${var.environment}"
  pubsub_topic_id = "control-plane-events-${var.environment}"

  common_labels = {
    environment = var.environment
    tenant-id   = var.tenant_id
    managed-by  = "terraform"
    component   = "sandbox-egress-proxy"
  }
}

# -----------------------------------------------------------------------------
# GCS bucket — stores envoy.yaml, mounted read-only into the sidecar container.
# -----------------------------------------------------------------------------

resource "google_storage_bucket" "proxy_config" {
  count = var.create_bucket ? 1 : 0

  name     = local.bucket_name
  project  = var.project_id
  location = "US"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  force_destroy = false # Config files only — no reason to force-destroy

  labels = local.common_labels
}

# Upload the static envoy.yaml from this module's envoy-config/ directory.
# The sidecar mounts this file at /etc/envoy/envoy.yaml via a cloud_storage volume.
resource "google_storage_bucket_object" "envoy_config" {
  name   = "envoy.yaml"
  bucket = local.bucket_name
  source = "${path.module}/envoy-config/envoy.yaml"

  depends_on = [google_storage_bucket.proxy_config]
}

# Grant sandbox-executor SA read access so Cloud Run can mount the bucket as a volume.
resource "google_storage_bucket_iam_member" "sandbox_executor_config_reader" {
  bucket = local.bucket_name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${var.sandbox_executor_sa_email}"

  depends_on = [google_storage_bucket.proxy_config]
}

# -----------------------------------------------------------------------------
# Cross-project Pub/Sub publisher — audit events go to control-plane-events-{env}
# which lives in YOUR_GCP_PROJECT, not in the tenant project.
# -----------------------------------------------------------------------------

resource "google_pubsub_topic_iam_member" "sandbox_executor_audit_publisher" {
  project = var.control_plane_project_id
  topic   = local.pubsub_topic_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${var.sandbox_executor_sa_email}"
}

# -----------------------------------------------------------------------------
# Push subscription — delivers sandbox egress audit events from Envoy to
# platform-backend's audit API. Disabled by default (create_push_subscription =
# false) until platform-backend deploys the /api/agent-audit-logs/sandbox-events
# endpoint. Set create_push_subscription = true and provide platform_backend_url
# to activate.
# -----------------------------------------------------------------------------

# Push subscription: delivers sandbox egress audit events to platform-backend.
# Auth uses a shared secret token embedded in the push endpoint URL as a query
# parameter (?token=...). Pub/Sub OIDC token auth requires cross-project
# iam.serviceAccounts.actAs which is blocked by org policy constraints.
resource "google_pubsub_subscription" "sandbox_audit_push" {
  count   = var.create_push_subscription ? 1 : 0
  project = var.control_plane_project_id
  name    = "sandbox-egress-audit-push-${var.tenant_id}-${var.environment}"
  topic   = local.pubsub_topic_id

  push_config {
    # Token appended as query param; platform-backend's sandboxPushAuthMiddleware
    # validates it via timing-safe compare against SANDBOX_AUDIT_PUSH_TOKEN env var.
    push_endpoint = "${var.platform_backend_url}/api/agent-audit-logs/sandbox-events?token=${var.sandbox_push_token}"
  }

  # Retry policy: 10-600 second backoff
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  # Keep messages for 7 days if delivery fails
  message_retention_duration = "604800s"
  ack_deadline_seconds       = 60
}
