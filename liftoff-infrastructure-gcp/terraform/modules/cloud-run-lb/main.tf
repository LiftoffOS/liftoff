# One global external Application Load Balancer in front of a set of public
# hostnames, each backed by a Cloud Run service. This is the only place a TLS
# floor can be enforced: a Cloud Run domain mapping terminates on Google's
# shared frontend and negotiates TLS 1.0, and it cannot carry an SSL policy.
#
# Shape (copied from platform-control/tunnel_service.tf, the first LB here):
#   - EXTERNAL_MANAGED scheme, which supports SSL policies and serverless NEGs.
#   - Certificate Manager with DNS authorization, not the classic managed
#     certificate. A classic certificate only provisions once the hostname
#     already resolves to the load balancer, which forces a window where the
#     host serves an invalid certificate. DNS authorization issues the
#     certificate while DNS still points at the domain mapping, so the cutover
#     is a single DNS change with the certificate already ACTIVE.
#   - One NEG and one backend service per HOST, not per service. Both are free,
#     and the split lets a low-volume webhook host keep full LB request logs
#     while a high-volume host logs nothing at the LB (Cloud Run already logs
#     every request it receives).
#   - A host in another project is reached through an internet NEG. Serverless
#     NEGs cannot cross projects; internet NEGs can. The load balancer sends
#     the configured FQDN as SNI and, via `custom_request_headers`, as Host,
#     which is what Cloud Run's frontend routes on.
#   - Or by naming an existing backend service or bucket in another project of
#     the same organization (`backend`): a global external Application Load
#     Balancer's URL map may reference them directly, without Shared VPC, and
#     the origin keeps its own ingress setting (cloud load balancing admits it).
#
# Cost: this module never adds a forwarding rule beyond the two it creates
# (443 and the 80 → 443 redirect). The first five global forwarding rules in a
# project are covered by that project's flat minimum; keep each project at or
# under five.

locals {
  # Resource-name suffix per host: the label under the zone, `apex` for the zone itself.
  slug = {
    for h, _ in var.hosts :
    h => h == var.zone_name ? "apex" : replace(trimsuffix(h, ".${var.zone_name}"), ".", "-")
  }

  cloud_run_hosts = { for h, c in var.hosts : h => c if c.cloud_run_service != null }
  origin_hosts    = { for h, c in var.hosts : h => c if c.origin_fqdn != null }

  backend_id = merge(
    { for h, _ in local.cloud_run_hosts : h => google_compute_backend_service.cloud_run[h].id },
    { for h, _ in local.origin_hosts : h => google_compute_backend_service.origin[h].id },
    { for h, c in var.hosts : h => c.backend if c.backend != null },
  )

  # Certificate group → its hosts, sorted (the certificate's domain order).
  certificates = {
    for g in distinct([for _, c in var.hosts : c.certificate]) :
    g => sort([for h, c in var.hosts : h if c.certificate == g])
  }

  dns_name = "${var.lb_dns_label}.${var.zone_name}"
}

# ─── Address ──────────────────────────────────────────────────────────────────

resource "google_compute_global_address" "this" {
  project = var.project_id
  name    = "${var.name}-lb-ip"
}

# ─── Backends: Cloud Run services in this project ─────────────────────────────

resource "google_compute_region_network_endpoint_group" "cloud_run" {
  for_each = local.cloud_run_hosts

  project               = var.project_id
  name                  = "${var.name}-lb-${local.slug[each.key]}"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = each.value.cloud_run_service
  }
}

resource "google_compute_backend_service" "cloud_run" {
  for_each = local.cloud_run_hosts

  project               = var.project_id
  name                  = "${var.name}-lb-${local.slug[each.key]}"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"

  # No `timeout_sec`: the backend service timeout does not apply to serverless
  # NEG backends. Cloud Run's own request timeout governs.

  backend {
    group = google_compute_region_network_endpoint_group.cloud_run[each.key].id
  }

  log_config {
    enable      = each.value.log_sample_rate > 0
    sample_rate = each.value.log_sample_rate > 0 ? each.value.log_sample_rate : null
  }
}

# ─── Backends: HTTPS origins in another project (internet NEG) ────────────────

resource "google_compute_global_network_endpoint_group" "origin" {
  for_each = local.origin_hosts

  project               = var.project_id
  name                  = "${var.name}-lb-${local.slug[each.key]}"
  network_endpoint_type = "INTERNET_FQDN_PORT"
  default_port          = 443
}

resource "google_compute_global_network_endpoint" "origin" {
  for_each = local.origin_hosts

  project                       = var.project_id
  global_network_endpoint_group = google_compute_global_network_endpoint_group.origin[each.key].name
  fqdn                          = each.value.origin_fqdn
  port                          = 443
}

resource "google_compute_backend_service" "origin" {
  for_each = local.origin_hosts

  project               = var.project_id
  name                  = "${var.name}-lb-${local.slug[each.key]}"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"

  # Cloud Run's frontend routes on Host. Without this the origin would see the
  # public hostname, which it has no mapping for once the domain mapping goes.
  custom_request_headers = ["Host: ${each.value.origin_fqdn}"]

  backend {
    group = google_compute_global_network_endpoint_group.origin[each.key].id
  }

  log_config {
    enable      = each.value.log_sample_rate > 0
    sample_rate = each.value.log_sample_rate > 0 ? each.value.log_sample_rate : null
  }

  depends_on = [google_compute_global_network_endpoint.origin]
}

# ─── Routing ──────────────────────────────────────────────────────────────────

resource "google_compute_url_map" "this" {
  project         = var.project_id
  name            = "${var.name}-lb"
  default_service = local.backend_id[var.default_host]

  dynamic "host_rule" {
    for_each = var.hosts
    content {
      hosts        = [host_rule.key]
      path_matcher = local.slug[host_rule.key]
    }
  }

  dynamic "path_matcher" {
    for_each = var.hosts
    content {
      name            = local.slug[path_matcher.key]
      default_service = local.backend_id[path_matcher.key]

      dynamic "path_rule" {
        for_each = path_matcher.value.path_rules
        content {
          paths   = [path_rule.key]
          service = path_rule.value
        }
      }
    }
  }

  lifecycle {
    precondition {
      condition     = contains(keys(var.hosts), var.default_host)
      error_message = "default_host must be one of the keys of hosts."
    }
  }
}

# ─── Certificate ──────────────────────────────────────────────────────────────

resource "google_certificate_manager_dns_authorization" "host" {
  for_each = var.hosts

  project     = var.project_id
  name        = "${var.name}-lb-${local.slug[each.key]}"
  description = "DNS-01 authorization for ${each.key}"
  domain      = each.key
  type        = each.value.dns_authorization_type
}

# CNAME Cloudflare publishes to satisfy the DNS-01 challenge. The authorization
# resource exposes the exact name/value pair.
resource "cloudflare_record" "dns_auth" {
  for_each = var.hosts

  zone_id = var.cloudflare_zone_id
  name    = google_certificate_manager_dns_authorization.host[each.key].dns_resource_record[0].name
  type    = google_certificate_manager_dns_authorization.host[each.key].dns_resource_record[0].type
  content = google_certificate_manager_dns_authorization.host[each.key].dns_resource_record[0].data
  proxied = false
  ttl     = 300
  comment = "DNS-01 authorization for ${each.key}" # Cloudflare caps comments at 100 characters
}

resource "google_certificate_manager_certificate" "this" {
  for_each = local.certificates

  project = var.project_id
  name    = each.key == "default" ? "${var.name}-lb" : "${var.name}-lb-${each.key}"
  scope   = "DEFAULT"

  managed {
    domains            = each.value
    dns_authorizations = [for h in each.value : google_certificate_manager_dns_authorization.host[h].id]
  }
}

moved {
  from = google_certificate_manager_certificate.this
  to   = google_certificate_manager_certificate.this["default"]
}

resource "google_certificate_manager_certificate_map" "this" {
  project = var.project_id
  name    = "${var.name}-lb"
}

resource "google_certificate_manager_certificate_map_entry" "host" {
  for_each = var.hosts

  project      = var.project_id
  name         = "${var.name}-lb-${local.slug[each.key]}"
  map          = google_certificate_manager_certificate_map.this.name
  certificates = [google_certificate_manager_certificate.this[each.value.certificate].id]
  hostname     = each.key
}

# ─── Front end ────────────────────────────────────────────────────────────────

resource "google_compute_target_https_proxy" "this" {
  project         = var.project_id
  name            = "${var.name}-lb-https"
  url_map         = google_compute_url_map.this.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.this.id}"
  ssl_policy      = var.ssl_policy_id

  depends_on = [google_certificate_manager_certificate_map_entry.host]
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "${var.name}-lb-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.this.id
  ip_address            = google_compute_global_address.this.id
}

# A domain mapping redirects HTTP to HTTPS implicitly; a load balancer has to
# do it explicitly.
resource "google_compute_url_map" "redirect" {
  project = var.project_id
  name    = "${var.name}-lb-http-redirect"

  default_url_redirect {
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.project_id
  name    = "${var.name}-lb-http"
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.project_id
  name                  = "${var.name}-lb-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect.id
  ip_address            = google_compute_global_address.this.id
}

# ─── The load balancer's own name ─────────────────────────────────────────────
# Hosts are cut over by pointing their CNAME here (see `lb_dns_label`).

resource "cloudflare_record" "lb" {
  zone_id = var.cloudflare_zone_id
  name    = var.lb_dns_label
  type    = "A"
  content = google_compute_global_address.this.address
  proxied = false
  ttl     = 300
  comment = "${var.name} load balancer IP; public hosts CNAME here"
}
