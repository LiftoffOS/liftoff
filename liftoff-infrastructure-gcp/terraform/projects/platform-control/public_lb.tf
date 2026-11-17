# Public hosts of the control plane behind one load balancer, so that every
# one of them enforces TLS 1.2+ in transit (a Cloud Run domain mapping
# negotiates TLS 1.0 and cannot carry an SSL policy).
#
#   api[-env].example.com             → platform-backend
#   webhooks[-env].example.com        → platform-backend (host-discipline serves only POST /v1/<token>)
#   connectors[-env].example.com      → connector-service
#   anchor-webhooks[-env].example.com → anchor-webhook-receiver in YOUR_TENANT_PROJECT,
#                                         through an internet NEG. The tenant projects have
#                                         no load balancer and must not get one: a project's
#                                         first forwarding rule starts its flat minimum charge.
#
# Cutover is per host, driven from tfvars: `public_lb_cutover[label] = true`
# points the host's CNAME at the load balancer's own name instead of
# ghs.googlehosted.com. The domain mapping keeps working until it is deleted,
# so rollback before that is reverting the flag.

variable "public_lb_enabled" {
  type        = bool
  default     = false
  description = <<-EOT
    Whether to provision the public-host load balancer (address, NEGs, backends,
    URL map, Certificate Manager certificate + DNS authorizations, proxies,
    forwarding rules) and take the public host DNS records into Terraform.
    False keeps every root without a Cloudflare provider (staging) inert.
  EOT
}

variable "public_lb_cutover" {
  type        = map(bool)
  default     = {}
  description = <<-EOT
    Per-host flag (keys: api, webhooks, connectors, anchor) that points the host's
    CNAME at the load balancer. Absent or false leaves it on ghs.googlehosted.com
    (the Cloud Run domain mapping). Flip only after the certificate is ACTIVE.
  EOT
}

variable "run_app_ingress_closed" {
  type        = bool
  default     = false
  description = <<-EOT
    When true, platform-backend and connector-service take
    INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER: the load balancer (TLS 1.2+) and
    same-project Google sources (Pub/Sub push, Cloud Tasks, Cloud Scheduler)
    still reach them; the direct *.run.app URL, which negotiates TLS 1.0, no
    longer answers. Flip only once every caller has been re-pointed at the
    public hostname. The Anchor
    receiver in the tenant project is not covered: the internet NEG reaches it
    from outside, so its ingress must stay open.
  EOT
}

variable "anchor_webhook_receiver_origin" {
  type        = string
  default     = ""
  description = <<-EOT
    Public HTTPS origin of the anchor-webhook-receiver in the tenant project, as
    a bare hostname: its deterministic Cloud Run URL host
    (anchor-webhook-receiver-<TENANT_PROJECT_NUMBER>.<region>.run.app). Empty
    leaves the Anchor host off the load balancer.
  EOT
}

variable "public_site_hosts" {
  type = map(object({
    backend    = string
    path_rules = optional(map(string), {})
  }))
  default     = {}
  description = <<-EOT
    The web app's hosts (YOUR_WEB_PROJECT's `public_site_hosts` output),
    served by this load balancer from backend services and a bucket that stay in
    the YOUR_WEB_PROJECT project. Every project's first global forwarding rule
    starts a flat minimum charge; this project's rules already pay it. The site's
    hosts share their own certificate, so adding them never reissues the one the
    API serves, and their DNS authorizations are PER_PROJECT_RECORD because the
    website project holds FIXED_RECORD ones for the same names. DNS for these
    hosts is YOUR_WEB_PROJECT's (public_lb.tf).
  EOT
}

# One SSL policy per project, attached to every HTTPS proxy in it. MODERN
# keeps the ECDHE cipher suites and drops the rest; RESTRICTED would be
# stricter than "TLS 1.2+" needs and risks an older webhook sender.
resource "google_compute_ssl_policy" "tls12_modern" {
  project         = google_project.platform_control.project_id
  name            = "tls12-modern"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"

  depends_on = [google_project_service.apis]
}

locals {
  public_host_suffix = var.environment == "prod" ? "" : "-${var.environment}"

  # Every entry carries the same attributes so the map has one element type;
  # `present` filters out hosts whose origin does not exist in this environment.
  public_hosts_all = {
    api = {
      hostname          = "api${local.public_host_suffix}.example.com"
      cloud_run_service = module.platform_backend.service_name
      origin_fqdn       = null
      log_sample_rate   = 0
      present           = true
    }
    webhooks = {
      hostname          = "webhooks${local.public_host_suffix}.example.com"
      cloud_run_service = module.platform_backend.service_name
      origin_fqdn       = null
      log_sample_rate   = 1
      present           = true
    }
    connectors = {
      hostname          = "connectors${local.public_host_suffix}.example.com"
      cloud_run_service = module.connector_service.service_name
      origin_fqdn       = null
      log_sample_rate   = 0
      present           = var.connector_service_enabled
    }
    anchor = {
      hostname          = "anchor-webhooks${local.public_host_suffix}.example.com"
      cloud_run_service = null
      origin_fqdn       = var.anchor_webhook_receiver_origin
      log_sample_rate   = 1
      present           = var.anchor_webhook_receiver_origin != ""
    }
  }

  public_hosts = { for label, h in local.public_hosts_all : label => h if h.present && var.public_lb_enabled }
}

module "public_lb" {
  count  = var.public_lb_enabled ? 1 : 0
  source = "../../modules/cloud-run-lb"

  project_id         = google_project.platform_control.project_id
  region             = var.region
  name               = "platform-${var.environment}"
  cloudflare_zone_id = var.cloudflare_zone_id
  ssl_policy_id      = google_compute_ssl_policy.tls12_modern.id
  lb_dns_label       = "platform-lb-${var.environment}"
  default_host       = local.public_hosts_all.api.hostname

  hosts = merge(
    {
      for label, h in local.public_hosts : h.hostname => {
        cloud_run_service = h.cloud_run_service
        origin_fqdn       = h.origin_fqdn
        log_sample_rate   = h.log_sample_rate
      }
    },
    {
      for host, h in var.public_site_hosts : host => {
        backend                = h.backend
        path_rules             = h.path_rules
        certificate            = "site"
        dns_authorization_type = "PER_PROJECT_RECORD"
      }
    },
  )

  depends_on = [google_project_service.apis]
}

# The public host records themselves. Every one of these is a CNAME whose
# content is the only thing the cutover changes; a type change would be a
# destroy + create in the cloudflare provider and an NXDOMAIN in between.
resource "cloudflare_record" "public_host" {
  for_each = local.public_hosts

  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(each.value.hostname, ".example.com")
  type    = "CNAME"
  content = lookup(var.public_lb_cutover, each.key, false) ? module.public_lb[0].dns_name : "ghs.googlehosted.com"
  proxied = false # Google terminates TLS; Cloudflare proxying breaks the handshake and would hold plaintext
  ttl     = 300
}

output "public_lb_ip" {
  description = "Static IP of the public-host load balancer, or null while disabled."
  value       = var.public_lb_enabled ? module.public_lb[0].ip_address : null
}

output "public_lb_dns_name" {
  description = "The A record naming the public-host load balancer, or null while disabled."
  value       = var.public_lb_enabled ? module.public_lb[0].dns_name : null
}

output "public_lb_certificate" {
  description = "Certificate Manager certificate for the public hosts; wait for managed.state=ACTIVE before any cutover."
  value       = var.public_lb_enabled ? module.public_lb[0].certificate_name : null
}

output "public_lb_site_certificate" {
  description = "Certificate Manager certificate for the site's hosts; wait for managed.state=ACTIVE before pointing their DNS here."
  value       = var.public_lb_enabled ? lookup(module.public_lb[0].certificate_names, "site", null) : null
}
