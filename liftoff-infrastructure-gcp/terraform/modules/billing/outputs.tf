# billing: outputs

output "service_account_email" {
  description = "Billing service account email. Always populated."
  value       = google_service_account.billing.email
}

output "service_url" {
  description = "Cloud Run URL of the private billing service, empty when enabled=false."
  value       = var.enabled ? google_cloud_run_v2_service.billing[0].uri : ""
}

output "stripe_webhook_url" {
  description = "Public HTTPS URL of the Stripe webhook Cloud Run service, empty when enabled=false."
  value       = var.enabled ? google_cloud_run_v2_service.billing_stripe_webhook[0].uri : ""
}

output "db_name" {
  description = "Name of the billing database on control-plane-pg."
  value       = google_sql_database.billing.name
}

output "kms_key_id" {
  description = "Fully-qualified resource ID of the billing-key CMEK in keyring-{env}."
  value       = google_kms_crypto_key.billing.id
}

output "enabled" {
  description = "Pass-through of var.enabled."
  value       = var.enabled
}

output "cutover_state_bucket" {
  description = "GCS bucket name for billing cutover quiesce state (liftoff-billing-cutover-{env})."
  value       = google_storage_bucket.billing_cutover_state.name
}

output "migration_sa_email" {
  description = "Billing migration service account email."
  value       = google_service_account.billing_migration.email
}
