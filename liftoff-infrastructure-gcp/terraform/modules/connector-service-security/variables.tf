# connector-service-security: variables
# Phase 4 security hardening — VPC Service Controls perimeter for Connector Service

variable "project_id" {
  description = "GCP project ID that hosts the Connector Service"
  type        = string
}

variable "connector_service_sa_email" {
  description = "Service account email of the Connector Service Cloud Run service"
  type        = string
}

variable "allowed_caller_projects" {
  description = <<-EOT
    List of GCP project numbers (as strings) that are permitted to call the
    Connector Service. Typically the set of tenant runtime project numbers.
    Each entry will be added to the VPC-SC perimeter as an ingress source.
  EOT
  type        = list(string)
  default     = []
}

variable "org_id" {
  description = "GCP Organization ID (numeric string, e.g. \"123456789012\")"
  type        = string
}

variable "access_policy_name" {
  description = <<-EOT
    Short name (not the full resource name) of the Access Context Manager policy
    to use. The policy must already exist under the organization.
    Example: \"platform\"
  EOT
  type        = string
}

variable "restricted_services" {
  description = "GCP services to restrict inside the perimeter"
  type        = list(string)
  default = [
    "secretmanager.googleapis.com",
    "run.googleapis.com",
    "cloudfunctions.googleapis.com",
  ]
}

variable "additional_vpc_accessible_services" {
  description = <<-EOT
    Extra Google API services (beyond the perimeter's restricted_services) that
    in-VPC workloads may call. Appended to vpc_accessible_services.allowed_services.
    e.g. ["storage.googleapis.com"] so the agent-diagnostics job can write its GCS
    scorecard sink from inside the perimeter's VPC.
  EOT
  type        = list(string)
  default     = []
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "enabled" {
  description = <<-EOT
    Whether to create VPC-SC resources. Defaults to true only for prod.
    Set explicitly to override.
  EOT
  type        = bool
  default     = null
}

variable "admin_members" {
  description = <<-EOT
    Additional members (user:foo@bar.com, group:..., serviceAccount:...)
    granted access to the perimeter via the same access level as the
    Connector Service SA. Used to let human operators describe/manage
    the Cloud Run service from outside the perimeter (e.g. from a
    workstation) without widening the ingress rules.
  EOT
  type        = list(string)
  default     = []
}
