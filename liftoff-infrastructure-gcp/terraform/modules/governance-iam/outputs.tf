# governance-iam: outputs

output "tenant_runtime_invoker_binding" {
  description = <<-EOT
    IAM binding ID for the tenant-runtime SA → Cloud Run invoker grant on
    the Governance Engine.
  EOT
  value       = google_cloud_run_v2_service_iam_member.tenant_runtime_invoker.id
}

output "tenant_runtime_governance_engine_token_binding" {
  description = <<-EOT
    IAM binding ID for the tenant-runtime SA → governance-engine-token
    Secret Manager accessor grant.
  EOT
  value       = google_secret_manager_secret_iam_member.tenant_runtime_governance_engine_token.id
}

output "tenant_id" {
  description = "Tenant ID this IAM module is scoped to"
  value       = var.tenant_id
}
