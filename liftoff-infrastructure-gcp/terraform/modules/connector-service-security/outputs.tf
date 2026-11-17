# connector-service-security: outputs

output "perimeter_name" {
  description = "Full resource name of the VPC-SC service perimeter, or empty string if disabled"
  value       = local.is_enabled ? google_access_context_manager_service_perimeter.connector_service[0].name : ""
}

output "perimeter_enabled" {
  description = "Whether the VPC-SC perimeter was actually created"
  value       = local.is_enabled
}

output "connector_sa_access_level_name" {
  description = "Full resource name of the access level granted to the Connector Service SA"
  value       = local.is_enabled ? google_access_context_manager_access_level.connector_service_sa[0].name : ""
}

# Placeholder — wire this to the WIF STS pool once it is provisioned.
# When the Connector Service authenticates tenant-runtime callers via Workload
# Identity Federation, the STS binding reference goes here so downstream
# modules can read it without hard-coding the pool ID.
#
# TODO: Replace this with the actual WIF pool resource reference, e.g.:
#   value = google_iam_workload_identity_pool.connector_service[0].name
output "sts_binding_reference" {
  description = "Workload Identity Federation pool reference (TODO: replace placeholder once WIF pool is provisioned)"
  value       = "TODO: wire to google_iam_workload_identity_pool resource"
}
