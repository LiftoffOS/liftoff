output "service_account_email" {
  value = google_service_account.workforce.email
}

output "service_url" {
  value = var.enabled ? google_cloud_run_v2_service.workforce[0].uri : ""
}

output "service_name" {
  description = "Cloud Run service name (consumed by project-level IAM bindings, e.g. self-invoker for Cloud Tasks delivery)."
  value       = local.service_name
}

output "db_name" {
  value = google_sql_database.workforce.name
}

output "kms_key_id" {
  value = google_kms_crypto_key.workforce.id
}

output "enabled" {
  value = var.enabled
}
