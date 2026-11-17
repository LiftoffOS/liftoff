# governance-iam: variables
# Phase 3 — per-tenant IAM for Governance Engine access.

variable "tenant_id" {
  description = "Tenant ID (e.g. \"acme\"). Used in resource tags / descriptions."
  type        = string
}

variable "governance_engine_project_id" {
  description = "GCP project ID that hosts the Governance Engine"
  type        = string
}

variable "governance_engine_url" {
  description = "Cloud Run URL of the Governance Engine (e.g. https://governance-engine-xxx.run.app). Currently unused but kept for parity with connector-iam and future Pub/Sub push endpoints."
  type        = string
  default     = ""
}

variable "governance_engine_sa_email" {
  description = <<-EOT
    Email of the Governance Engine service account. Kept as an input for
    parity with connector-iam (and for forward compatibility if we later
    add a tenant-scoped IAM binding — e.g. governance read of a tenant-
    owned secret for customer-managed policy bundles).
  EOT
  type        = string
  default     = ""
}

variable "tenant_runtime_sa_email" {
  description = <<-EOT
    Email of the tenant-runtime service account that should be granted
    Cloud Run invoker permission on the Governance Engine.
    Typically: tenant-{tenant_id}-runtime@{tenant_project_id}.iam.gserviceaccount.com
  EOT
  type        = string
}

variable "governance_engine_cloud_run_service_name" {
  description = "Cloud Run service name for the Governance Engine (used for invoker IAM binding)"
  type        = string
  default     = "governance-engine"
}

variable "region" {
  description = "GCP region where the Governance Engine Cloud Run service is deployed"
  type        = string
  default     = "us-west1"
}
