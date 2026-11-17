# connector-iam: outputs

output "connector_service_secret_accessor_binding" {
  description = <<-EOT
    IAM binding ID for the Connector Service SA → Secret Manager accessor grant.
    Scoped via IAM condition to connector-{tenant_id}-* secrets.
  EOT
  value       = google_project_iam_member.connector_service_secret_accessor.id
}

output "tenant_runtime_invoker_binding" {
  description = <<-EOT
    IAM binding ID for the tenant-runtime SA → Cloud Run invoker grant on
    the Connector Service.
  EOT
  value       = google_cloud_run_v2_service_iam_member.tenant_runtime_invoker.id
}

output "tenant_id" {
  description = "Tenant ID this IAM module is scoped to"
  value       = var.tenant_id
}

output "iam_condition_expression" {
  description = "CEL expression used to scope the Secret Manager access to this tenant's secrets"
  value       = "resource.name.startsWith(\"projects/${var.secret_manager_project_id}/secrets/connector-${var.tenant_id}-\")"
}
