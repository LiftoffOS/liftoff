# developer-proxy: variables.
# Cloud Run deployment for liftoff-developer-proxy (Phase 1.5 of platform-backend
# decomposition). Developer vendor-API proxy — hot SSE path, min-instances=1.

variable "project_id" {
  type        = string
  description = "GCP project ID (YOUR_GCP_PROJECT)."
}

variable "environment" {
  type        = string
  description = "dev / prod."
}

variable "region" {
  type        = string
  description = "GCP region — hard-coded us-west1."
  default     = "us-west1"
}

variable "billing_account" {
  type        = string
  description = "GCP billing account, used for labels."
}

variable "control_plane_sql_instance" {
  type        = string
  description = "Name of control-plane-pg-{env}."
}

variable "control_plane_sql_connection_name" {
  type        = string
  description = "Cloud SQL connection name for control-plane-pg-{env}."
}

variable "kms_key_ring_id" {
  type        = string
  description = "keyring-{env} full resource ID."
}

variable "network_id" {
  type        = string
  description = "VPC network ID."
}


variable "platform_backend_sa_email" {
  type        = string
  description = "Platform Backend SA email. Granted run.invoker on developer-proxy."
}

variable "image_sha" {
  type    = string
  default = "placeholder"
  # TODO: image SHA when liftoff-developer-proxy first builds.
  description = "SHA-only image tag."
}

variable "enabled" {
  type        = bool
  default     = false
  description = "Gate Cloud Run + invoker IAM creation until the first image is published."
}

variable "min_instances" {
  type    = number
  default = 0
  # 0 until there is traffic to protect from a cold start. The 15-minute
  # cost-attribution ingest poll keeps an instance warm most of the time anyway.
  description = "Cloud Run min-instances."
}

variable "max_instances" {
  type        = number
  default     = 20
  description = "Cloud Run max-instances."
}

variable "db_app_password" {
  type        = string
  sensitive   = true
  description = "developer_proxy_app SQL user password."
}

variable "db_migrate_password" {
  type        = string
  sensitive   = true
  description = "developer_proxy_migrate SQL user password."
}

variable "db_readonly_password" {
  type        = string
  sensitive   = true
  description = "developer_proxy_readonly SQL user password."
}

variable "notification_channels" {
  type        = list(string)
  default     = []
  description = "Cloud Monitoring notification channels."
}

variable "billing_service_url" {
  type        = string
  description = "Internal URL of the billing Cloud Run service for developer-proxy usage tracking."
  default     = ""
}

variable "binary_authorization_enabled" {
  type        = bool
  default     = true
  description = "Create per-service Binary Authorization attestor."
}

variable "cloud_build_trigger_enabled" {
  description = "Whether to create the Cloud Build trigger. Set true only once the GitHub App connection and builder service account are confirmed in the target project."
  type        = bool
  default     = false
}

variable "vpc_network_id" {
  description = "VPC network for Direct VPC egress (replaces the Serverless VPC Access connector)."
  type        = string
}

variable "vpc_subnetwork_id" {
  description = "Subnetwork Cloud Run takes egress IPs from (Direct VPC egress)."
  type        = string
}
