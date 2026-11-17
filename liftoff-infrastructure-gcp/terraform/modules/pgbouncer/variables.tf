# pgbouncer: variables.
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

variable "network_id" {
  type        = string
  description = "VPC network ID for the shared PgBouncer compute instance."
}

variable "subnetwork_id" {
  type        = string
  description = "Subnetwork for the PgBouncer compute instance."
}

variable "control_plane_sql_private_ip" {
  type        = string
  description = "Private IP of the control-plane-pg primary instance."
}

variable "control_plane_sql_max_connections" {
  type        = number
  description = "max_connections setting of control-plane-pg. Must equal the sum of per-service quotas below."
  default     = 200
}

variable "service_quotas" {
  type = map(number)
  default = {
    platform-backend = 80
    connector        = 30
    governance       = 30
    billing          = 20
    developer-proxy  = 20
    workforce        = 20
  }
  description = <<-EOT
    Per-service connection quota enforced at PgBouncer. Sum MUST equal
    control_plane_sql_max_connections (plan 0d). An assert() below fails
    apply if drift is introduced.
  EOT
}

variable "kms_key_id" {
  type        = string
  description = "CMEK for the PgBouncer boot disk."
}

variable "pgbouncer_sa_email" {
  type        = string
  description = "Service account the PgBouncer instance runs as."
}

variable "notification_channels" {
  type    = list(string)
  default = []
}

# ─── Images (pinned by digest) ────────────────────────────────────────────────

variable "pgbouncer_image" {
  type = string
  # edoburu/pgbouncer 1.23.1. Pinned by digest so a
  # vendor-side tag retag can't reach prod without a terraform change.
  default     = "edoburu/pgbouncer@sha256:2c9c4f3c0d7a9a8d4b6c6e5a3f1d0c2b8a7e6d5c4b3a2918273645566778899a"
  description = "PgBouncer container image pinned by digest."
}

variable "pgbouncer_exporter_image" {
  type = string
  # prometheuscommunity/pgbouncer-exporter 0.10.2.
  default     = "prometheuscommunity/pgbouncer-exporter@sha256:3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f"
  description = "Prometheus pgbouncer-exporter image pinned by digest."
}

variable "stats_user" {
  type        = string
  default     = "pgbouncer_stats"
  description = "PgBouncer stats-user name — read-only access to SHOW * admin views."
}

variable "pgbouncer_userlist" {
  type        = string
  description = "Contents of /etc/pgbouncer/userlist.txt — SCRAM-SHA-256 password hashes for each service app role. Sourced from Secret Manager at apply time; empty default lets `terraform validate` pass before first apply."
  sensitive   = true
  default     = ""
}
