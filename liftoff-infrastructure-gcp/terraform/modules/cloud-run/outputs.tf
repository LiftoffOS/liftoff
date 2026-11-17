# Cloud Run Module Outputs

output "service_name" {
  description = "Name of the Cloud Run service"
  value       = google_cloud_run_v2_service.service.name
}

output "service_uri" {
  description = "URI of the Cloud Run service"
  value       = google_cloud_run_v2_service.service.uri
}

output "service_id" {
  description = "Full resource ID of the Cloud Run service"
  value       = google_cloud_run_v2_service.service.id
}

output "latest_revision" {
  description = "Name of the latest revision"
  value       = google_cloud_run_v2_service.service.latest_ready_revision
}

output "service_limits" {
  description = "Default service instance limits per Section 5"
  value       = local.default_service_limits
}

output "location" {
  description = "Location of the Cloud Run service"
  value       = google_cloud_run_v2_service.service.location
}
