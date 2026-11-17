variable "environment" {
  description = "Environment name (dev, prod). Used to name the GCS bucket and Pub/Sub topic."
  type        = string
}

variable "project_id" {
  description = "GCP project ID that hosts the sandbox Cloud Run service and owns the proxy config bucket. This is the tenant project (tenant-<id>-<env>)."
  type        = string
}

variable "tenant_id" {
  description = "Tenant identifier. Used for resource naming and labelling."
  type        = string
}

variable "region" {
  description = "GCP region for the proxy config bucket's uniform location."
  type        = string
  default     = "us-west1"
}

variable "proxy_config_bucket" {
  description = <<-EOT
    Name of the GCS bucket that stores the envoy.yaml config file. The bucket is
    created by this module when create_bucket=true. When wiring into the sandbox
    Cloud Run service template, the bucket name is used as the cloud_storage.bucket
    attribute of the envoy-config volume.

    If not provided, defaults to "sandbox-proxy-config-<tenant_id>-<environment>".
  EOT
  type        = string
  default     = ""
}

variable "create_bucket" {
  description = <<-EOT
    Whether this module should create the GCS proxy config bucket. Set to false if
    the bucket is managed externally (e.g. created by the tenant provisioning script).
  EOT
  type        = bool
  default     = true
}

variable "control_plane_project_id" {
  description = <<-EOT
    GCP project ID that owns the control-plane-events-<env> Pub/Sub topic
    (typically YOUR_GCP_PROJECT<env>). The module grants the sandbox
    executor SA roles/pubsub.publisher on that topic so it can emit audit events.
  EOT
  type        = string
}

variable "sandbox_executor_sa_email" {
  description = "Email of the sandbox-executor service account. Granted roles/pubsub.publisher on the audit topic."
  type        = string
}

variable "create_push_subscription" {
  description = "Whether to create the Pub/Sub push subscription for sandbox audit events. Requires platform_backend_url and sandbox_push_token."
  type        = bool
  default     = false
}

variable "platform_backend_url" {
  description = "Base URL of the platform-backend service (e.g. https://api.example.com). Required when create_push_subscription = true."
  type        = string
  default     = ""
}

variable "sandbox_push_token" {
  description = <<-EOT
    Shared secret token appended to the push endpoint URL as ?token=<value>.
    platform-backend's sandboxPushAuthMiddleware validates it via timing-safe
    compare. Required when create_push_subscription = true. Sensitive.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "vendor_domain_allowlist" {
  description = <<-EOT
    Comma-separated list of vendor API domains that the Envoy Lua filter treats as
    known endpoints. Write calls (POST/PUT/PATCH/DELETE) to these domains trigger a
    preflight GET to snapshot pre-action state before forwarding.

    Glob patterns (*.salesforce.com) are supported by the Lua matching logic; they
    are not evaluated by Envoy's route config.
  EOT
  type        = list(string)
  default = [
    "api.salesforce.com",
    "*.salesforce.com",
    "api.hubapi.com",
    "slack.com",
    "*.slack.com",
    "*.googleapis.com",
    "graph.microsoft.com",
    "*.microsoft.com",
    "api.github.com",
    "api.notion.com",
    "api.stripe.com",
    "api.linear.app",
    "api.atlassian.com",
    "*.atlassian.net",
    "api.sendgrid.com",
    "api.mailchimp.com",
    "api.intercom.io",
    "api.zendesk.com",
    "api.dropboxapi.com",
    "api.box.com",
    "zoom.us",
    "*.zoom.us",
  ]
}
