# The web app's backends and DNS. The site is served by the control
# project's load balancer (platform-control/public_lb.tf, `public_site_hosts`),
# which enforces TLS 1.2+ in transit (a Cloud Run domain mapping negotiates
# TLS 1.0 and cannot carry an SSL policy).
#
#   example.com, www.example.com -> liftoff-react (serverless NEGs below)
#
# The backends stay here because a serverless NEG must live in its Cloud Run
# service's project; the control URL map references them across projects. This
# project has no forwarding rule of its own: a project's first global forwarding
# rule starts a flat minimum charge, which the control project already pays.
# liftoff-react is deployed by its own Cloud Build, not by Terraform.

variable "cloudflare_zone_id" {
  type        = string
  default     = ""
  description = "Cloudflare zone id for example.com. Required when public_lb_enabled."
}

variable "site_lb" {
  type = object({
    ip       = string
    dns_name = string
  })
  description = "The control project's load balancer, which serves the site's hosts. Every site record points here."
}

locals {
  site_hosts = {
    "example.com"     = "apex"
    "www.example.com" = "www"
  }
}

resource "google_compute_region_network_endpoint_group" "site" {
  for_each = local.site_hosts

  project               = var.project_id
  name                  = "website-lb-${each.value}"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = "liftoff-react"
  }
}

resource "google_compute_backend_service" "site" {
  for_each = local.site_hosts

  project               = var.project_id
  name                  = "website-lb-${each.value}"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"

  backend {
    group = google_compute_region_network_endpoint_group.site[each.key].id
  }

  log_config {
    enable = false
  }
}

moved {
  from = module.public_lb[0].google_compute_region_network_endpoint_group.cloud_run["example.com"]
  to   = google_compute_region_network_endpoint_group.site["example.com"]
}
moved {
  from = module.public_lb[0].google_compute_region_network_endpoint_group.cloud_run["www.example.com"]
  to   = google_compute_region_network_endpoint_group.site["www.example.com"]
}
moved {
  from = module.public_lb[0].google_compute_backend_service.cloud_run["example.com"]
  to   = google_compute_backend_service.site["example.com"]
}
moved {
  from = module.public_lb[0].google_compute_backend_service.cloud_run["www.example.com"]
  to   = google_compute_backend_service.site["www.example.com"]
}

# Every record changes content only, never type: a type change is a destroy +
# create in the cloudflare provider, and the gap is an NXDOMAIN resolvers cache.
resource "cloudflare_record" "public_host" {
  for_each = toset(["www"])

  zone_id = var.cloudflare_zone_id
  name    = each.key
  type    = "CNAME"
  content = var.site_lb.dns_name
  proxied = false # Google terminates TLS; Cloudflare proxying breaks the handshake and would hold plaintext
  ttl     = 300
}

resource "cloudflare_record" "apex" {
  for_each = toset(["lb"])

  zone_id = var.cloudflare_zone_id
  name    = "example.com"
  type    = "A"
  content = var.site_lb.ip
  proxied = false
  ttl     = 300
}

output "public_site_hosts" {
  description = "Hosts for the control load balancer: each names a backend service or bucket in this project."
  value = {
    "example.com"     = { backend = google_compute_backend_service.site["example.com"].id, path_rules = {} }
    "www.example.com" = { backend = google_compute_backend_service.site["www.example.com"].id, path_rules = {} }
  }
}
