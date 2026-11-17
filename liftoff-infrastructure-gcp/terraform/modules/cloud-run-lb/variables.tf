variable "project_id" {
  type        = string
  description = "Project that owns the load balancer. Serverless NEGs can only point at Cloud Run services in this project."
}

variable "region" {
  type        = string
  description = "Region of the Cloud Run services behind the serverless NEGs."
}

variable "name" {
  type        = string
  description = "Prefix for every GCP resource name (e.g. `platform-prod` → `platform-prod-lb-ip`, `platform-prod-lb-api`)."
}

variable "zone_name" {
  type        = string
  default     = "example.com"
  description = "The Cloudflare zone every host lives in. A host equal to the zone is the apex."
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare zone id for the DNS-authorization CNAMEs and the load balancer's own A record."
}

variable "ssl_policy_id" {
  type        = string
  description = "SSL policy attached to the HTTPS proxy. This is where the TLS floor is enforced."
}

variable "lb_dns_label" {
  type        = string
  description = <<-EOT
    Label of the A record that names this load balancer's IP (`<label>.<zone_name>`).
    Hosts are cut over by pointing their CNAME at this name, which is an in-place
    content change in Cloudflare. Changing a record's type instead (CNAME → A) is a
    destroy + create in the cloudflare provider, and the gap between the two is an
    NXDOMAIN that resolvers negative-cache.
  EOT
}

variable "default_host" {
  type        = string
  description = "Host whose backend receives requests that match no host rule (a raw-IP request, for instance)."
}

variable "hosts" {
  type = map(object({
    # Exactly one of the three origins.
    cloud_run_service = optional(string) # a Cloud Run service in `project_id` (serverless NEG)
    origin_fqdn       = optional(string) # a public HTTPS origin in another project (internet NEG)
    backend           = optional(string) # an existing backend service or backend bucket, any project in the org
    # Path patterns routed somewhere other than the host's own backend, to an
    # existing backend service or bucket: { "/mcp" = <id>, "/mcp/*" = <id> }.
    path_rules = optional(map(string), {})
    # Hosts are grouped into certificates by this name. A new group gets its own
    # certificate, so adding hosts never reissues the one live hosts serve.
    certificate = optional(string, "default")
    # PER_PROJECT_RECORD when another project already holds a DNS authorization
    # for the same name: FIXED_RECORD's CNAME name is the same in every project.
    dns_authorization_type = optional(string)
    # Load-balancer request logs. Cloud Run already logs every request it
    # receives, so the LB log only adds value on hosts whose traffic is
    # low-volume and worth a second, LB-side view (webhook receivers).
    log_sample_rate = optional(number, 0)
  }))
  description = "Public hostnames served by this load balancer, keyed by FQDN."

  validation {
    condition = alltrue([
      for h, c in var.hosts : length(compact([c.cloud_run_service, c.origin_fqdn, c.backend])) == 1
    ])
    error_message = "Each host needs exactly one of cloud_run_service, origin_fqdn or backend."
  }

  validation {
    condition = alltrue([
      for h, c in var.hosts : c.log_sample_rate >= 0 && c.log_sample_rate <= 1
    ])
    error_message = "log_sample_rate must be between 0 and 1."
  }
}
