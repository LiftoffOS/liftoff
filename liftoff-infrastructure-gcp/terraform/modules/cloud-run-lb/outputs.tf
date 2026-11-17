output "ip_address" {
  description = "Static IPv4 address of the load balancer."
  value       = google_compute_global_address.this.address
}

output "dns_name" {
  description = "The A record naming this load balancer. Point a host's CNAME here to cut it over."
  value       = local.dns_name
}

output "certificate_name" {
  description = "Name of the default group's Certificate Manager certificate, for `gcloud certificate-manager certificates describe`."
  value       = google_certificate_manager_certificate.this["default"].name
}

output "certificate_names" {
  description = "Certificate Manager certificate name per certificate group."
  value       = { for g, c in google_certificate_manager_certificate.this : g => c.name }
}

output "backend_ids" {
  description = "Backend (service or bucket) id per host, for another project's load balancer to reference."
  value       = local.backend_id
}
