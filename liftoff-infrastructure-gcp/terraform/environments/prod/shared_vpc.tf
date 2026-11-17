# The tenant runtime runs on the control project's network (Shared VPC).
#
# No customer needs a network of its own, and a separate one cost a VPC
# connector, a NAT gateway and a Cloud SQL instance that could not be shared,
# because the runtime reaches its database by private IP and the control
# database's private IP is reachable only from the control VPC. As a Shared VPC
# service project, the runtime's Cloud Run services and jobs use Direct VPC
# egress on `YOUR_GCP_PROJECT` and leave through the control NAT.
#
# Grants follow Cloud Run's Shared VPC + Direct VPC egress requirements: the
# service project's Cloud Run service agent needs compute.networkUser on the
# host; the principals that deploy (the prod build, and the runtime itself,
# which creates sandbox services) get compute.networkViewer to resolve the
# subnet.

resource "google_organization_iam_member" "infra_xpn_admin" {
  org_id = var.org_id
  role   = "roles/compute.xpnAdmin"
  member = "serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
}

resource "google_compute_shared_vpc_host_project" "control" {
  project = module.platform_control.project_id

  depends_on = [google_organization_iam_member.infra_xpn_admin]
}

resource "google_compute_shared_vpc_service_project" "tenant_liftoffos" {
  host_project    = google_compute_shared_vpc_host_project.control.project
  service_project = module.tenant_liftoffos.project_id
}

resource "google_project_iam_member" "tenant_liftoffos_run_agent_network_user" {
  project = module.platform_control.project_id
  role    = "roles/compute.networkUser"
  member  = "serviceAccount:service-${module.tenant_liftoffos.project_number}@serverless-robot-prod.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "tenant_liftoffos_network_viewer" {
  for_each = toset([
    "serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
    "serviceAccount:YOUR_TENANT_PROJECT@${module.tenant_liftoffos.project_id}.iam.gserviceaccount.com",
    "serviceAccount:sandbox-executor@${module.tenant_liftoffos.project_id}.iam.gserviceaccount.com",
  ])
  project = module.platform_control.project_id
  role    = "roles/compute.networkViewer"
  member  = each.value
}

# Sandboxes run code nobody reviewed, and the network they now share carries
# the control plane's database and services. Deny every private range to the
# sandbox network tag (tenant runtime: src/execution-environments/
# sandbox-vpc-access.ts, SANDBOX_NETWORK_TAG). Their callbacks to the runtime go
# to run.app addresses and their internet egress to public ones; neither is a
# private range. Stricter than the runtime's own network was, which had no
# egress rule at all.
resource "google_compute_firewall" "deny_sandbox_private_egress" {
  project            = module.platform_control.project_id
  name               = "deny-sandbox-private-egress"
  network            = "YOUR_GCP_PROJECT"
  direction          = "EGRESS"
  priority           = 900
  target_tags        = ["sandbox"]
  destination_ranges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"]

  deny {
    protocol = "all"
  }
}

# The runtime's deploys mount the control instance by connection name
# (--set-cloudsql-instances / --add-cloudsql-instances), which needs
# cloudsql.client on the instance's project for each identity that mounts it.
resource "google_project_iam_member" "tenant_liftoffos_cloudsql_client" {
  for_each = toset([
    "serviceAccount:YOUR_TENANT_PROJECT@${module.tenant_liftoffos.project_id}.iam.gserviceaccount.com",
    "serviceAccount:sandbox-executor@${module.tenant_liftoffos.project_id}.iam.gserviceaccount.com",
    "serviceAccount:${module.tenant_liftoffos.project_number}-compute@developer.gserviceaccount.com",
  ])
  project = module.platform_control.project_id
  role    = "roles/cloudsql.client"
  member  = each.value
}
