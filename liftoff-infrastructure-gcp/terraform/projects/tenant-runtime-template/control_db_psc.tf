# The runtime's database lives on the control plane's instance
# (control-plane-pg, database `tenant_runtime`): one customer does not need an
# instance of its own. The runtime keeps its own network and reaches that
# instance through a Private Service Connect endpoint on tenant_subnet, which
# needs no peering with the control VPC and nothing from the control project's
# service perimeter. The control side allows this project in
# platform-control/main.tf (`control_plane_psc_consumer_projects`).

variable "control_pg_psc_enabled" {
  description = "Whether the runtime has a PSC endpoint onto control-plane-pg. A flag of its own: the attachment link is unknown until the instance is patched, and count cannot wait for it."
  type        = bool
  default     = false
}

variable "control_pg_psc_service_attachment" {
  description = "control-plane-pg's PSC service attachment, the endpoint's target."
  type        = string
  default     = null
}

resource "google_compute_address" "control_pg_psc" {
  count = var.control_pg_psc_enabled ? 1 : 0

  project      = google_project.tenant_runtime.project_id
  name         = "control-pg-psc"
  region       = var.region
  subnetwork   = google_compute_subnetwork.tenant_subnet.id
  address_type = "INTERNAL"
}

resource "google_compute_forwarding_rule" "control_pg_psc" {
  count = var.control_pg_psc_enabled ? 1 : 0

  project               = google_project.tenant_runtime.project_id
  name                  = "control-pg-psc"
  region                = var.region
  network               = google_compute_network.tenant_vpc.id
  ip_address            = google_compute_address.control_pg_psc[0].id
  target                = var.control_pg_psc_service_attachment
  load_balancing_scheme = ""
}

output "control_pg_psc_ip" {
  description = "Address the runtime's DB_HOST points at to reach control-plane-pg, or null without an endpoint."
  value       = var.control_pg_psc_enabled ? google_compute_address.control_pg_psc[0].address : null
}

# Where the runtime's database is: the control instance through the endpoint
# once the endpoint exists, the tenant instance before that.
locals {
  runtime_db_host = var.control_pg_psc_enabled ? google_compute_address.control_pg_psc[0].address : data.google_sql_database_instance.tenant_pg[0].private_ip_address
}
