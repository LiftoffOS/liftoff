output "service_account_email" {
  description = "Developer Proxy SA email."
  value       = google_service_account.developer_proxy.email
}

output "service_url" {
  description = "Cloud Run URL (empty when enabled=false)."
  value       = var.enabled ? google_cloud_run_v2_service.developer_proxy[0].uri : ""
}

output "db_name" {
  description = "Name of the developer_proxy database on control-plane-pg."
  value       = google_sql_database.developer_proxy.name
}

output "kms_key_id" {
  description = "Fully-qualified resource ID of developer-proxy-key."
  value       = google_kms_crypto_key.developer_proxy.id
}

output "enabled" {
  value = var.enabled
}
