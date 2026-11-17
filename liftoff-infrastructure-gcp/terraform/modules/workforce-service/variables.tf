# workforce-service: variables.
# liftoff-workforce-service — HRBP + CAIO orchestration. Phase 3.

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

variable "billing_account" {
  type = string
}

variable "control_plane_sql_instance" {
  type = string
}

variable "control_plane_sql_connection_name" {
  type = string
}

variable "kms_key_ring_id" {
  type = string
}

variable "network_id" {
  type = string
}


variable "platform_backend_sa_email" {
  type = string
}

variable "image_sha" {
  type    = string
  default = "placeholder"
  # TODO: image SHA when liftoff-workforce-service first builds.
}

variable "enabled" {
  type    = bool
  default = false
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "max_instances" {
  type    = number
  default = 10
}

variable "db_app_password" {
  type      = string
  sensitive = true
}

variable "db_migrate_password" {
  type      = string
  sensitive = true
}

variable "db_readonly_password" {
  type      = string
  sensitive = true
}

variable "notification_channels" {
  type    = list(string)
  default = []
}

variable "binary_authorization_enabled" {
  type    = bool
  default = true
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
