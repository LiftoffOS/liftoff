# governance-engine: outputs

output "project_id" {
  description = "GCP project ID where the Governance Engine lives (pass-through of var.project_id)"
  value       = var.project_id
}

output "service_account_email" {
  description = "Email of the Governance Engine service account. Always populated — use in governance-iam for per-tenant invoker grants."
  value       = google_service_account.governance_engine.email
}

output "service_account_name" {
  description = "Full resource name of the Governance Engine service account"
  value       = google_service_account.governance_engine.name
}

output "service_url" {
  description = "Cloud Run URL of the Governance Engine, or empty string if var.enabled = false"
  value       = var.enabled ? google_cloud_run_v2_service.governance_engine[0].uri : ""
}

output "service_name" {
  description = "Cloud Run service name, or empty string if var.enabled = false"
  value       = var.enabled ? google_cloud_run_v2_service.governance_engine[0].name : ""
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL connection name of the instance holding governance_engine (control-plane-pg)"
  value       = var.sql_connection_name
}

output "cloud_sql_instance_name" {
  description = "Cloud SQL name of the instance holding governance_engine (control-plane-pg)"
  value       = element(split(":", var.sql_connection_name), 2)
}

output "enabled" {
  description = "Whether the Cloud Run service and platform-backend invoker IAM binding were created"
  value       = var.enabled
}

output "reconciliation_job_name" {
  description = "Name of the nightly reconciliation Cloud Run Job, or empty string when reconciliation_enabled = false"
  value       = local.reconciliation_enabled ? google_cloud_run_v2_job.governance_reconciliation[0].name : ""
}

output "reconciliation_schedule" {
  description = "Cron schedule applied to the reconciliation Cloud Scheduler job (empty when disabled)"
  value       = local.reconciliation_enabled ? var.reconciliation_schedule : ""
}

output "partition_job_name" {
  description = "Name of the monthly partition-management Cloud Run Job, or empty string when partition_management_enabled = false"
  value       = local.partition_management_enabled ? local.governance_partitions_job_name : ""
}

output "partition_schedule" {
  description = "Cron schedule applied to the partition-management Cloud Scheduler job (empty when disabled)"
  value       = local.partition_management_enabled ? var.partition_schedule : ""
}
