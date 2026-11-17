output "proxy_config_bucket_name" {
  description = "Name of the GCS bucket that stores envoy.yaml. Pass to the sandbox Cloud Run service template as the cloud_storage.bucket attribute of the envoy-config volume."
  value       = local.bucket_name
}

output "proxy_config_bucket_url" {
  description = "gs:// URI of the proxy config bucket."
  value       = "gs://${local.bucket_name}"
}

output "envoy_config_object_name" {
  description = "Object name of the uploaded envoy.yaml inside the proxy config bucket."
  value       = google_storage_bucket_object.envoy_config.name
}

output "audit_pubsub_topic_id" {
  description = "Pub/Sub topic ID (short form, without projects/... prefix) that the sidecar publishes audit events to."
  value       = local.pubsub_topic_id
}

output "vendor_domain_allowlist_csv" {
  description = "Comma-separated vendor domain allowlist string, suitable for passing as the VENDOR_DOMAIN_ALLOWLIST env var on the sidecar container."
  value       = join(",", var.vendor_domain_allowlist)
}

output "push_subscription_name" {
  description = "Name of the Pub/Sub push subscription (if created)."
  value       = var.create_push_subscription ? one(google_pubsub_subscription.sandbox_audit_push[*].name) : null
}
