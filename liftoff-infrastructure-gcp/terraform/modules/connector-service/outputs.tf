# connector-service: outputs

output "service_account_email" {
  description = "Email of the Connector Service service account. Always populated — use in connector-iam and connector-service-security modules."
  value       = google_service_account.connector_service.email
}

output "service_account_name" {
  description = "Full resource name of the Connector Service service account"
  value       = google_service_account.connector_service.name
}

output "service_url" {
  description = "Cloud Run URL of the Connector Service, or empty string if var.enabled = false"
  value       = var.enabled ? google_cloud_run_v2_service.connector_service[0].uri : ""
}

output "service_name" {
  description = "Cloud Run service name, or empty string if var.enabled = false"
  value       = var.enabled ? google_cloud_run_v2_service.connector_service[0].name : ""
}

output "database_connection_name" {
  description = "Cloud SQL connection name of the instance holding connector_service (control-plane-pg)"
  value       = var.sql_connection_name
}

output "database_instance_name" {
  description = "Cloud SQL name of the instance holding connector_service (control-plane-pg)"
  value       = element(split(":", var.sql_connection_name), 2)
}

output "enabled" {
  description = "Whether the Cloud Run service and Cloud SQL instance were created"
  value       = var.enabled
}
