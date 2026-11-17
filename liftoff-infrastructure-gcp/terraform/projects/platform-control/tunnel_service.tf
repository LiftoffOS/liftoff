# =============================================================================
# Tunnel Service (liftoff-tunnel-service)
# =============================================================================
# Multi-tenant terminator for the private MCP reverse-tunnel. Co-located with
# platform-backend in YOUR_GCP_PROJECT per the
# "tunnel service co-located in platform-control" decision.
#
# Stack:
#   - Cloud Run service (GCLB-fronted, ingress=INTERNAL_LOAD_BALANCER)
#   - Dedicated SA with narrow IAM (mcp-tunnel-token-* access only)
#   - Global GCLB: static IP + serverless NEG + backend (timeoutSec=86400)
#     + URL map + target HTTPS proxy + forwarding rule
#   - Google-managed wildcard cert (*.tunnels.example.com + apex)
#   - Cloudflare DNS A records (proxy OFF — Google needs to see the cert ACME
#     challenge for managed-cert provisioning)
#   - Pub/Sub topic mcp-tunnel-routes-changed-{env} + push subscription
#     to https://tunnels.example.com/_tunnel/pubsub/routes-changed
#   - 3 × Cloud Scheduler jobs (sweep-disconnected, sweep-pending,
#     sweep-token-grace) targeting platform-backend internal endpoints
#   - tunnel-service-token Secret Manager entry (X-Service-Auth between
#     tunnel-service and platform-backend, mirrors harvest-service-token)
# =============================================================================

# -----------------------------------------------------------------------------
# Service Account
# -----------------------------------------------------------------------------

resource "google_service_account" "tunnel_service" {
  project      = google_project.platform_control.project_id
  account_id   = "tunnel-service"
  display_name = "Tunnel Service"
  description  = "Multi-tenant terminator for the MCP reverse-tunnel"
}

# -----------------------------------------------------------------------------
# Service-auth token (tunnel-service ↔ platform-backend)
# -----------------------------------------------------------------------------
# Mirrors the harvest-service-token pattern. Created unconditionally so the
# tunnel_service Cloud Run service can reference it whether or not
# tunnel_service_enabled is true.

resource "random_password" "tunnel_service_token" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "tunnel_service_token" {
  labels    = { type = "service-auth", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "tunnel-service-token"

  replication {
    user_managed {
      replicas {
        location = var.region
        customer_managed_encryption {
          kms_key_name = google_kms_crypto_key.secrets.id
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_kms_crypto_key_iam_member.secretmanager_secrets_key,
  ]
}

resource "google_secret_manager_secret_version" "tunnel_service_token" {
  secret      = google_secret_manager_secret.tunnel_service_token.id
  secret_data = random_password.tunnel_service_token.result
}

# tunnel-service reads the token to send on X-Service-Auth to PB internal endpoints.
resource "google_secret_manager_secret_iam_member" "tunnel_service_token_access" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.tunnel_service_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.tunnel_service.email}"
}

# platform-backend reads the token to validate inbound tunnel-service calls.
resource "google_secret_manager_secret_iam_member" "tunnel_service_token_platform_backend_access" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.tunnel_service_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.platform_backend.email}"
}

# -----------------------------------------------------------------------------
# mcp-tunnel-token-* Secret Manager IAM (per-tenant chisel-client tokens)
# -----------------------------------------------------------------------------
# PB creates + rotates these secrets dynamically per tenant_prefix.
# tunnel-service only needs read access to validate inbound chisel handshakes.
# Use IAM Conditions to scope the grant by secret-name prefix without granting
# project-wide secretAccessor.

resource "google_project_iam_member" "tunnel_service_tunnel_token_reader" {
  project = google_project.platform_control.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.tunnel_service.email}"

  condition {
    title       = "mcp-tunnel-token-prefix-only"
    description = "Restrict secretAccessor to mcp-tunnel-token-* secrets only"
    expression  = "resource.name.startsWith(\"projects/${google_project.platform_control.number}/secrets/mcp-tunnel-token-\")"
  }
}

# PB needs full secret admin on the mcp-tunnel-token-* prefix (create, rotate,
# disable versions). Scope identically.
resource "google_project_iam_member" "platform_backend_tunnel_token_admin" {
  project = google_project.platform_control.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"

  condition {
    title       = "mcp-tunnel-token-prefix-only"
    description = "Restrict secretmanager.admin to mcp-tunnel-token-* secrets only"
    expression  = "resource.name.startsWith(\"projects/${google_project.platform_control.number}/secrets/mcp-tunnel-token-\")"
  }
}

# -----------------------------------------------------------------------------
# Pub/Sub: route-change invalidation
# -----------------------------------------------------------------------------

resource "google_pubsub_topic" "tunnel_routes_changed" {
  project = google_project.platform_control.project_id
  name    = "mcp-tunnel-routes-changed-${var.environment}"

  message_retention_duration = "86400s" # 1 day

  depends_on = [google_project_service.apis]
}

# PB publishes to this topic.
resource "google_pubsub_topic_iam_member" "tunnel_routes_changed_pb_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.tunnel_routes_changed.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Push subscription delivers to the tunnel-service GCLB URL.
# Use the apex hostname (var.tunnel_base_domain) as a stable control-plane
# endpoint; cert covers both apex and wildcard.
resource "google_pubsub_subscription" "tunnel_routes_changed_push" {
  count   = var.tunnel_service_enabled ? 1 : 0
  project = google_project.platform_control.project_id
  name    = "mcp-tunnel-routes-changed-${var.environment}-sub"
  topic   = google_pubsub_topic.tunnel_routes_changed.name

  ack_deadline_seconds       = 30
  message_retention_duration = "3600s" # 1 hour — handler is idempotent

  push_config {
    push_endpoint = "https://${var.tunnel_base_domain}/_tunnel/pubsub/routes-changed"

    oidc_token {
      service_account_email = google_service_account.tunnel_service_pubsub_push.email
      audience              = "https://${var.tunnel_base_domain}"
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  expiration_policy { ttl = "" } # never expire
}

# Dedicated push SA so we can scope its IAM independently from tunnel-service.
resource "google_service_account" "tunnel_service_pubsub_push" {
  project      = google_project.platform_control.project_id
  account_id   = "tunnel-routes-changed-push"
  display_name = "Pub/Sub Push: mcp-tunnel-routes-changed"
  description  = "OIDC token signer for Pub/Sub push to tunnel-service"
}

# -----------------------------------------------------------------------------
# Cloud Run service: tunnel-service
# -----------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "tunnel_service" {
  count    = var.tunnel_service_enabled ? 1 : 0
  project  = google_project.platform_control.project_id
  name     = "tunnel-service"
  location = var.region

  # GCLB-only ingress. Pub/Sub push targets the GCLB hostname
  # (tunnels.example.com), not the *.run.app URL, so this ingress is
  # sufficient.
  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account = google_service_account.tunnel_service.email
    timeout         = "3600s" # long chisel sessions

    # Per-instance concurrency. Chisel sessions are long-lived; many
    # customers per instance share via multiplexing.
    max_instance_request_concurrency = 1000

    scaling {
      min_instance_count = var.tunnel_service_min_instances
      max_instance_count = 50
    }

    # Session affinity ON: Host header keys each tenant_prefix to the
    # instance holding that customer's chisel session.
    session_affinity = true

    containers {
      image = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/YOUR_GCP_PROJECT${var.environment}/tunnel-service:${var.environment}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        # Request-based CPU. A chisel session is one long-lived request, so its
        # keepalives run while it is open; with none open there is nothing to
        # tick, and always-on CPU billed ~$100/mo per env for scanner traffic.
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = google_project.platform_control.project_id
      }
      env {
        name  = "PLATFORM_BACKEND_URL"
        value = local.platform_backend_public_url # the load balancer hostname; platform-backend's ingress admits no other path from a Cloud Run service
      }
      env {
        name  = "TUNNEL_BASE_DOMAIN"
        value = var.tunnel_base_domain
      }
      # PORT is automatically set by Cloud Run from container_port; do not
      # pass it as an env var (Cloud Run rejects reserved env names).
      # Token tunnel-service sends on X-Service-Auth to PB internal endpoints.
      # The Go code reads PLATFORM_BACKEND_SERVICE_TOKEN, not TUNNEL_SERVICE_TOKEN
      # (PB-side is the symmetric pairing — same secret, different env-var label).
      env {
        name = "PLATFORM_BACKEND_SERVICE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.tunnel_service_token.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.tunnel_service_token,
    google_secret_manager_secret_iam_member.tunnel_service_token_access,
  ]

  lifecycle {
    # Cloud Build owns the deployed image SHA on each push; Terraform only
    # manages infra (ingress, concurrency, scaling, env vars, secrets).
    ignore_changes = [
      template[0].containers[0].image,
    ]
  }
}

# -----------------------------------------------------------------------------
# GCLB stack
# -----------------------------------------------------------------------------

# Cloud Run IAM: allUsers invoker. Safe because ingress=INTERNAL_LOAD_BALANCER
# means GCLB is the only path that can reach the service; the LB-delivered
# traffic still needs to be allowed by Cloud Run's IAM layer to actually
# invoke. Without this grant, GCLB → Cloud Run returns 403.
resource "google_cloud_run_v2_service_iam_member" "tunnel_service_public" {
  count    = var.tunnel_service_enabled ? 1 : 0
  project  = google_project.platform_control.project_id
  location = google_cloud_run_v2_service.tunnel_service[0].location
  name     = google_cloud_run_v2_service.tunnel_service[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_compute_global_address" "tunnel_service_ip" {
  count   = var.tunnel_service_enabled ? 1 : 0
  project = google_project.platform_control.project_id
  name    = "tunnel-service-${var.environment}-ip"

  depends_on = [google_project_service.apis]
}

resource "google_compute_region_network_endpoint_group" "tunnel_service_neg" {
  count                 = var.tunnel_service_enabled ? 1 : 0
  project               = google_project.platform_control.project_id
  name                  = "tunnel-service-${var.environment}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.tunnel_service[0].name
  }
}

resource "google_compute_backend_service" "tunnel_service" {
  count                 = var.tunnel_service_enabled ? 1 : 0
  project               = google_project.platform_control.project_id
  name                  = "tunnel-service-${var.environment}"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"

  # `timeout_sec` is not valid for backend services fronted by a serverless
  # NEG (Cloud Run owns request timeout via its own `template.timeout`). Per-
  # request cap is set to 3600s (Cloud Run gen2 max) on the Cloud Run service.

  backend {
    group = google_compute_region_network_endpoint_group.tunnel_service_neg[0].id
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

# Certificate Manager (not google_compute_managed_ssl_certificate) — the
# legacy classic cert resource does NOT support wildcard domains, but
# Certificate Manager does via DNS-01 authorization. Auth + cert + map +
# entry are separate resources; map is attached to the target HTTPS proxy.

resource "google_certificate_manager_dns_authorization" "tunnel_service" {
  count       = var.tunnel_service_enabled ? 1 : 0
  project     = google_project.platform_control.project_id
  name        = "tunnel-service-${var.environment}-dns-auth"
  description = "DNS-01 authorization for *.${var.tunnel_base_domain} wildcard cert"
  domain      = var.tunnel_base_domain
}

resource "google_certificate_manager_certificate" "tunnel_service" {
  count   = var.tunnel_service_enabled ? 1 : 0
  project = google_project.platform_control.project_id
  name    = "tunnel-service-${var.environment}"
  scope   = "DEFAULT"
  managed {
    domains            = [var.tunnel_base_domain, "*.${var.tunnel_base_domain}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.tunnel_service[0].id]
  }
}

resource "google_certificate_manager_certificate_map" "tunnel_service" {
  count   = var.tunnel_service_enabled ? 1 : 0
  project = google_project.platform_control.project_id
  name    = "tunnel-service-${var.environment}"
}

resource "google_certificate_manager_certificate_map_entry" "tunnel_service_apex" {
  count        = var.tunnel_service_enabled ? 1 : 0
  project      = google_project.platform_control.project_id
  name         = "tunnel-service-${var.environment}-apex"
  map          = google_certificate_manager_certificate_map.tunnel_service[0].name
  certificates = [google_certificate_manager_certificate.tunnel_service[0].id]
  hostname     = var.tunnel_base_domain
}

resource "google_certificate_manager_certificate_map_entry" "tunnel_service_wildcard" {
  count        = var.tunnel_service_enabled ? 1 : 0
  project      = google_project.platform_control.project_id
  name         = "tunnel-service-${var.environment}-wildcard"
  map          = google_certificate_manager_certificate_map.tunnel_service[0].name
  certificates = [google_certificate_manager_certificate.tunnel_service[0].id]
  hostname     = "*.${var.tunnel_base_domain}"
}

# CNAME record Cloudflare needs to publish to satisfy the DNS-01 challenge.
# The dns_authorization resource exposes the exact target/value pair.
resource "cloudflare_record" "tunnel_service_dns_auth" {
  count   = var.tunnel_service_enabled ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = google_certificate_manager_dns_authorization.tunnel_service[0].dns_resource_record[0].name
  type    = google_certificate_manager_dns_authorization.tunnel_service[0].dns_resource_record[0].type
  content = google_certificate_manager_dns_authorization.tunnel_service[0].dns_resource_record[0].data
  proxied = false
  ttl     = 300
  comment = "Certificate Manager DNS-01 authorization for tunnel-service wildcard cert"
}

resource "google_compute_url_map" "tunnel_service" {
  count           = var.tunnel_service_enabled ? 1 : 0
  project         = google_project.platform_control.project_id
  name            = "tunnel-service-${var.environment}"
  default_service = google_compute_backend_service.tunnel_service[0].id
}

resource "google_compute_target_https_proxy" "tunnel_service" {
  count           = var.tunnel_service_enabled ? 1 : 0
  project         = google_project.platform_control.project_id
  name            = "tunnel-service-${var.environment}"
  url_map         = google_compute_url_map.tunnel_service[0].id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.tunnel_service[0].id}"
  # TLS 1.2+ on every public host (public_lb.tf). The tunnel client is chisel
  # (Go TLS), which negotiates the MODERN profile's ECDHE suites.
  ssl_policy = google_compute_ssl_policy.tls12_modern.id
}

resource "google_compute_global_forwarding_rule" "tunnel_service_https" {
  count                 = var.tunnel_service_enabled ? 1 : 0
  project               = google_project.platform_control.project_id
  name                  = "tunnel-service-${var.environment}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.tunnel_service[0].id
  ip_address            = google_compute_global_address.tunnel_service_ip[0].id
}

# -----------------------------------------------------------------------------
# Cloudflare DNS — apex + wildcard A records pointing at the GCLB static IP.
# -----------------------------------------------------------------------------
# (The third Cloudflare record — the DNS-01 CNAME challenge — is declared
# above next to the certificate_manager_dns_authorization resource.)
# Proxy MUST be OFF (proxied=false) so the customer's chisel client opens a
# direct websocket to GCLB, not a Cloudflare-proxied connection.

locals {
  # Extract the leftmost label of the tunnel base domain — that's the
  # Cloudflare record `name`. e.g. "tunnels.example.com" → "tunnels",
  # "tunnels-dev.example.com" → "tunnels-dev".
  tunnel_subdomain_label = split(".", var.tunnel_base_domain)[0]
}

resource "cloudflare_record" "tunnels_apex" {
  count   = var.tunnel_service_enabled ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = local.tunnel_subdomain_label
  type    = "A"
  content = google_compute_global_address.tunnel_service_ip[0].address
  proxied = false
  ttl     = 300
  comment = "tunnel-service apex (control-plane) — ${var.environment}; managed by terraform/platform-control/tunnel_service.tf"
}

resource "cloudflare_record" "tunnels_wildcard" {
  count   = var.tunnel_service_enabled ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "*.${local.tunnel_subdomain_label}"
  type    = "A"
  content = google_compute_global_address.tunnel_service_ip[0].address
  proxied = false
  ttl     = 300
  comment = "tunnel-service wildcard (per-tenant) — ${var.environment}; managed by terraform/platform-control/tunnel_service.tf"
}

# -----------------------------------------------------------------------------
# Cloud Scheduler sweep jobs
# -----------------------------------------------------------------------------
# All three target platform-backend internal endpoints, not tunnel-service.
# Reuse the existing scheduler SA (google_service_account.scheduler).

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "tunnel_service_uri" {
  description = "Internal Cloud Run URI for tunnel-service (closed via ingress; for diagnostics only)"
  value       = var.tunnel_service_enabled ? google_cloud_run_v2_service.tunnel_service[0].uri : ""
}

output "tunnel_service_ip" {
  description = "GCLB static IP fronting *.tunnels.example.com"
  value       = var.tunnel_service_enabled ? google_compute_global_address.tunnel_service_ip[0].address : ""
}

output "tunnel_service_sa_email" {
  description = "Service account email for tunnel-service"
  value       = google_service_account.tunnel_service.email
}

output "tunnel_routes_changed_topic" {
  description = "Pub/Sub topic name for route-change invalidation"
  value       = google_pubsub_topic.tunnel_routes_changed.name
}
