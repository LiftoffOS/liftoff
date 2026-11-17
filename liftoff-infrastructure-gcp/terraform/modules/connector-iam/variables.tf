# connector-iam: variables
# Phase 4 security hardening — per-tenant IAM for Connector Service access

variable "tenant_id" {
  description = "Tenant ID (e.g. \"acme\"). Used to scope IAM conditions to connector-{tenant_id}-* secrets."
  type        = string
}

variable "connector_service_project_id" {
  description = "GCP project ID that hosts the Connector Service"
  type        = string
}

variable "connector_service_url" {
  description = "Cloud Run URL of the Connector Service (e.g. https://connector-service-xxx.run.app)"
  type        = string
}

variable "tenant_runtime_sa_email" {
  description = <<-EOT
    Email of the tenant-runtime service account that should be granted
    Cloud Run invoker permission on the Connector Service.
    Typically: tenant-{tenant_id}-runtime@{tenant_project_id}.iam.gserviceaccount.com
  EOT
  type        = string
}

variable "connector_service_sa_email" {
  description = <<-EOT
    Email of the Connector Service service account. This SA will receive
    a project-level secretmanager.secretAccessor role scoped via IAM condition
    to connector-{tenant_id}-* secrets only.
  EOT
  type        = string
}

variable "secret_manager_project_id" {
  description = <<-EOT
    GCP project ID where connector credential secrets live.
    In the current architecture this is the tenant-runtime project.
  EOT
  type        = string
}

variable "connector_service_cloud_run_service_name" {
  description = "Cloud Run service name for the Connector Service (used for invoker IAM binding)"
  type        = string
  default     = "connector-service"
}

variable "region" {
  description = "GCP region where the Connector Service Cloud Run service is deployed"
  type        = string
  default     = "us-west1"
}
