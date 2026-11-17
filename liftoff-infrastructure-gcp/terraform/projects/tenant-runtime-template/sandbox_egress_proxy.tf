# Sandbox Egress Proxy (System 1 — Audit Log Hardening)
#
# Wires the sandbox-egress-proxy module and adds the Envoy audit sidecar to the
# sandbox-executor Cloud Run service. See modules/sandbox-egress-proxy/main.tf for
# full background and design rationale.
#
# GATE VARIABLE
# -------------
# `sandbox_egress_proxy_enabled` defaults to false so existing tenants are not
# affected by the first terraform apply after this file lands. Set to true per
# tenant once the envoyproxy/envoy image has been validated in dev.
#
# CLOUD RUN MULTI-CONTAINER NOTE
# -------------------------------
# Cloud Run v2 supports multi-container ("sidecar") deployments. The audit-proxy
# container runs alongside sandbox-executor in the same task:
#   - sandbox-executor (main):  port 8080, proxies all HTTP via localhost:9901
#   - audit-proxy (sidecar):    port 9901 (forward proxy), 9902 (admin)
#
# The google_cloud_run_v2_service resource below is a SEPARATE resource that
# redefines sandbox-executor with the sidecar added. Terraform will want to
# update (not replace) the existing service because the name, project, and
# location match. If you would rather keep the change in the original resource
# block in main.tf, move the containers{} and volume{} blocks there and remove
# this file.
#
# PROVIDER COMPATIBILITY
# ----------------------
# cloud_storage volumes require google >= 5.25. The project uses ~> 5.0.
# If the provider version in your lock file is < 5.25, add lifecycle.ignore_changes
# on template[0].volumes and template[0].containers[1].volume_mounts until
# the provider is bumped, and inject the volume via cloudbuild deploy --add-volume
# (same pattern as split_services.tf /tmp volume).

variable "sandbox_egress_proxy_enabled" {
  description = <<-EOT
    Gate for the sandbox egress proxy sidecar (System 1 — Audit Log Hardening).
    When true, the sandbox-egress-proxy module is instantiated and the Envoy
    sidecar container is added to the sandbox-executor Cloud Run service.
    Defaults to false so existing environments are unaffected until explicitly
    opted in.
  EOT
  type        = bool
  default     = false
}

variable "control_plane_project_id" {
  description = <<-EOT
    GCP project ID that hosts the control-plane-events-<env> Pub/Sub topic
    (typically YOUR_GCP_PROJECT<env>). Required when
    sandbox_egress_proxy_enabled = true so the module can grant
    roles/pubsub.publisher to the sandbox-executor SA.
  EOT
  type        = string
  default     = ""
}

variable "create_push_subscription" {
  description = "Whether to create the Pub/Sub push subscription that delivers sandbox audit events to platform-backend's /api/agent-audit-logs/sandbox-events endpoint. Requires platform_backend_url and sandbox_push_token."
  type        = bool
  default     = false
}

variable "platform_backend_url" {
  description = "Base URL of the platform-backend service (e.g. https://api.example.com). Required when create_push_subscription = true."
  type        = string
  default     = ""
}

variable "sandbox_push_token" {
  description = "Shared secret token for Pub/Sub push authentication. Appended as ?token=<value> to the push endpoint URL. Required when create_push_subscription = true."
  type        = string
  sensitive   = true
  default     = ""
}

# -----------------------------------------------------------------------------
# Module instantiation — provisions the GCS bucket, uploads envoy.yaml,
# and wires IAM (bucket reader + Pub/Sub publisher).
# -----------------------------------------------------------------------------

module "sandbox_egress_proxy" {
  count  = var.sandbox_egress_proxy_enabled ? 1 : 0
  source = "../../modules/sandbox-egress-proxy"

  environment               = var.environment
  project_id                = google_project.tenant_runtime.project_id
  tenant_id                 = var.tenant_id
  region                    = var.region
  control_plane_project_id  = var.control_plane_project_id != "" ? var.control_plane_project_id : "YOUR_GCP_PROJECT${var.environment}"
  sandbox_executor_sa_email = google_service_account.sandbox_executor.email
  create_push_subscription  = var.create_push_subscription
  platform_backend_url      = var.platform_backend_url
  sandbox_push_token        = var.sandbox_push_token

  depends_on = [
    google_project_service.apis,
    google_service_account.sandbox_executor,
  ]
}

# -----------------------------------------------------------------------------
# CONSOLIDATED — the duplicate google_cloud_run_v2_service.sandbox_executor_with_proxy
# block that used to live here has been merged into main.tf's single
# google_cloud_run_v2_service.sandbox_executor resource. That block uses
# dynamic containers/volumes/env keyed off var.sandbox_egress_proxy_enabled.
#
# This file now retains only:
#   - The variables block for sandbox_egress_proxy_enabled / control_plane_project_id /
#     create_push_subscription / platform_backend_url / sandbox_push_token
#   - The module "sandbox_egress_proxy" instantiation (GCS config + IAM)
#
# The transitional duplicate Cloud Run service block is intentionally gone.
# Below the next line is a no-op marker block kept ONLY because removing the
# resource name would force a destroy on any tenant where the previous
# `count = 0` value evaluated to zero (state already empty); Terraform sees no
# diff. Newer applies skip past it via the count = 0 hard-coded gate.
# -----------------------------------------------------------------------------

resource "null_resource" "sandbox_executor_with_proxy_removed_marker" {
  count = 0
  triggers = {
    note = "Consolidated into main.tf google_cloud_run_v2_service.sandbox_executor"
  }
}
