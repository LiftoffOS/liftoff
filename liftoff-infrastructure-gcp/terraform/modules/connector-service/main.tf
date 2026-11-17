# connector-service: Connector Service Cloud Run deployment scaffold
# Phase 4 — Connector Service infrastructure
#
# What this module provisions:
#   1. Service account for the Connector Service Cloud Run service
#   2. Cloud SQL instance `connector-pg` (postgres) for connector credential state
#   3. Cloud Run service `liftoff-connector-service-{env}` (conditional on var.enabled)
#   4. IAM: Platform Backend SA → invoker on the Connector Service
#   5. Secret Manager secretAccessor for the Connector Service SA (all connector-* secrets)
#
# The Cloud Run service and Cloud SQL resources are gated behind var.enabled = true.
# This allows the module to be wired into platform-control environments before the
# Connector Service repo and container image exist, so per-tenant IAM grants (via
# the connector-iam module) can reference the SA email immediately.
#
# Resource naming follows the liftoff-{purpose}-{env} convention.
#
# TODO before enabling:
#   - Set var.enabled = true once the connector-service container image is published.
#   - Confirm var.network_id points at the VPC used by other platform-control services.
#   - Review db_tier: db-custom-2-4096 is a starting point; resize based on load tests.
#   - Add Cloud SQL IAM database user for the Connector Service SA using
#     google_sql_user with type = "CLOUD_IAM_SERVICE_ACCOUNT" once the DB is live.
#   - Wire connector-service-security module with this SA email and project_id.
#   - Wire connector-iam module for each dedicated tenant with this SA email.

locals {
  # Matches cloudbuild.yaml + platform-backend convention: plain service name,
  # env-scoped by the GCP project. SA gets the env suffix.
  service_name     = "connector-service"
  sa_account_id    = "connector-service-${var.environment}"
  sa_display_name  = "Connector Service — ${var.environment}"
  db_instance_name = "connector-pg-${var.environment}"

  private_network = var.network_id != "" ? var.network_id : "projects/${var.project_id}/global/networks/default"

  labels = {
    environment = var.environment
    managed-by  = "terraform"
    service     = "connector-service"
  }
}

# ─── Service Account ───────────────────────────────────────────────────────────
# The Connector Service Cloud Run service runs as this SA.
# Created unconditionally — needed by connector-iam module for per-tenant grants
# before the Cloud Run service itself is deployed.

resource "google_service_account" "connector_service" {
  project      = var.project_id
  account_id   = local.sa_account_id
  display_name = local.sa_display_name
  description  = "Service account for the Connector Service Cloud Run service (${var.environment})"
}

# ─── Secret Manager access for the Connector Service SA ───────────────────────
# Grants the Connector Service SA the ability to read connector credential
# secrets (named connector-*) within its own project.
# Per-tenant scoping is enforced by the connector-iam module via IAM conditions
# in each tenant's project. This project-level grant is the fallback for shared
# tenants whose secrets live in the platform-control project.

# Cloud Run evaluates Secret Manager IAM against the canonical resource
# name, which uses the project NUMBER (not project ID). The original CEL
# expression hard-coded the project ID so every request from Cloud Run hit
# a permission_denied at job/service revision time (see migration-job
# failure in build b8b07fcb). We need a reference to the project's number
# to build the correct condition.
data "google_project" "self" {
  project_id = var.project_id
}

# Cloud SQL client role — the connector-service SA is used by both the
# Cloud Run service and the migrate Cloud Run Job. Cloud Run's built-in
# Cloud SQL Auth Proxy sidecar authenticates as this SA to open the
# Unix socket at /cloudsql/<instance>. Without roles/cloudsql.client
# the socket file is never created and every DB query returns ENOENT.
resource "google_project_iam_member" "connector_service_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.connector_service.email}"
}

resource "google_project_iam_member" "connector_service_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.connector_service.email}"

  condition {
    title       = "connector-secrets-only-${var.environment}"
    description = "Restrict Connector Service SA to connector-* and per-connector oauth-client-* secrets"
    # Match both the project-ID form (gcloud display path) and the project-
    # NUMBER form (canonical Cloud Run evaluation). Per-tenant narrowing
    # (connector-{tenantId}-*) is layered on top by connector-iam.
    #
    # Secret classes granted:
    #   connector-*                                — per-instance OAuth tokens
    #   <vendor>-oauth-client-(id|secret)-<env>    — shared OAuth app credentials
    #   stripe-api-key-<env>                       — Stripe secret key
    #   stripe-webhook-secret-<env>                — Stripe webhook signing secret
    # GCP IAM CEL: only startsWith() and endsWith() are supported (contains() is NOT).
    # Max 12 logical operators per condition (7 used here — within limit).
    # oauth-client secrets follow the pattern "<vendor>-oauth-client-id-<env>" and
    # "<vendor>-oauth-client-secret-<env>", so endsWith() correctly matches them all
    # without needing per-vendor enumeration.
    expression = <<-EOT
      resource.name.startsWith("projects/${var.project_id}/secrets/connector-") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/connector-") ||
      resource.name.startsWith("projects/${var.project_id}/secrets/stripe-api-key-${var.environment}") ||
      resource.name.startsWith("projects/${var.project_id}/secrets/stripe-webhook-secret-${var.environment}") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/stripe-api-key-${var.environment}") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/stripe-webhook-secret-${var.environment}") ||
      resource.name.endsWith("-oauth-client-id-${var.environment}") ||
      resource.name.endsWith("-oauth-client-secret-${var.environment}")
    EOT
  }
}

# ─── Cloud SQL: connector-pg ───────────────────────────────────────────────────
# Connector Service database for credential metadata, rate-limit state, and
# per-tenant vendor account references.
#
# Created UNCONDITIONALLY. The DB must exist before cloudbuild.yaml can run
# its migration job, which happens on the first push to connector-
# service main — well before var.enabled flips to true for the Cloud Run
# service. Decoupling the DB from the service enablement lifecycle prevents
# a chicken-and-egg where the service can't deploy because the DB doesn't
# exist, but the DB can't be created because we haven't set enabled=true.

# connector_service lives on control-plane-pg rather than its own instance, to cut idle
# cost. The database, connector_app and the BYPASSRLS admin role there are created
# outside Terraform when the database is moved; take a final backup before
# deleting the old instance. State forgets these three without destroying anything.
removed {
  from = google_sql_database_instance.connector_pg
  lifecycle {
    destroy = false
  }
}

removed {
  from = google_sql_database.connector_pg_db
  lifecycle {
    destroy = false
  }
}

removed {
  from = google_sql_user.connector_app
  lifecycle {
    destroy = false
  }
}

# ─── Cloud Run: Connector Service ─────────────────────────────────────────────
# The Connector Service Cloud Run deployment.
# Conditional on var.enabled — set to true once the container image is published.

resource "google_cloud_run_v2_service" "connector_service" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = local.service_name
  location = var.region

  # Cross-project callers (tenant-runtime in YOUR_TENANT_PROJECT*) arrive through
  # the public-host load balancer at connectors[-env].example.com, so the
  # ingress may be INTERNAL_LOAD_BALANCER (see the variable). Never
  # INGRESS_TRAFFIC_INTERNAL_ONLY: that blocks the load balancer and every
  # cross-project caller, because no VPC peering exists between projects.
  # Security is enforced at the app layer via verifyServiceAuth middleware
  # (X-Service-Auth bearer token) and at the IAM layer via run.invoker
  # bindings in connector-iam.
  ingress = var.ingress

  labels = local.labels

  template {
    labels = local.labels

    service_account = google_service_account.connector_service.email

    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      # min_instances ≥ 1 in production to eliminate cold starts on the revenue path.
      # See plan performance requirements: p95 < 20ms Liftoff overhead.
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    timeout = "300s"

    max_instance_request_concurrency = 80

    containers {
      image = var.image

      # Bootstrap defaults. Values are ignored post-bootstrap (see
      # lifecycle.ignore_changes below) so the repo's cloudbuild.yaml owns
      # tuning. Match cloudbuild's deploy-step values for fresh-bootstrap
      # parity.
      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      # Standard environment variables
      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }

      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }

      env {
        name  = "GCP_REGION"
        value = var.region
      }

      # DB connection via Cloud SQL socket
      env {
        name  = "DB_INSTANCE_CONNECTION_NAME"
        value = var.sql_connection_name
      }

      env {
        name  = "DB_NAME"
        value = "connector_service"
      }

      # SQL user that the app connects as. Hardcoded here (mirrors the
      # username created in migrations/001 and the one configured in
      # cloudbuild.yaml's --set-env-vars). Without this, pool.ts falls
      # back to `connector_user` and fails password authentication —
      # surfaced as "password authentication failed for user
      # \"connector_user\"" on every RPC that touches the DB.
      env {
        name  = "DB_USER"
        value = "connector_app"
      }

      # Additional caller-supplied env vars (e.g. SENTRY_DSN, OTEL_EXPORTER_OTLP_ENDPOINT)
      dynamic "env" {
        for_each = var.env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      # Secrets from Secret Manager
      dynamic "env" {
        for_each = var.secrets
        content {
          name = env.value.name
          value_source {
            secret_key_ref {
              secret  = env.value.secret_name
              version = env.value.version
            }
          }
        }
      }

      liveness_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        period_seconds        = 30
        timeout_seconds       = 5
        failure_threshold     = 3
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 12
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [var.sql_connection_name]
      }
    }

    # Serverless VPC access — required so Cloud Run egress can reach
    # Cloud SQL over private IP. Without this the Auth Proxy sidecar's
    # dial to the private IP times out. `private-ranges-only` keeps
    # public internet traffic on the default Cloud Run egress path so
    # only RFC1918 destinations pay the VPC hop.
    vpc_access {
      network_interfaces {
        network    = var.vpc_network_id
        subnetwork = var.vpc_subnetwork_id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  # Terraform bootstraps the service and owns platform-wide concerns (project,
  # service account binding, Cloud SQL instance, VPC connector, ingress). The
  # connector-service repo's cloudbuild.yaml owns per-deploy runtime config
  # (image, env vars, scaling, resources, timeout, probes) via `gcloud run
  # deploy` — it has fresher context (SHORT_SHA, per-service env, memory
  # tuning). Without these ignore_changes, every infrastructure-apply would
  # revert cloudbuild's runtime config back to module defaults, silently
  # dropping env vars cloudbuild sets (CLOUD_SQL_CONNECTION_NAME, DB_USER,
  # SERVICE_VERSION, COMMIT_SHA) and causing RPC outages.
  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].annotations,
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].containers[0].resources,
      template[0].containers[0].liveness_probe,
      template[0].containers[0].startup_probe,
      template[0].scaling,
      template[0].timeout,
      template[0].max_instance_request_concurrency,
      template[0].vpc_access,
    ]
  }
}

# ─── IAM: Platform Backend → Connector Service invoker ────────────────────────
# The Platform Backend SA is granted roles/run.invoker on the Connector Service
# so it can call /api/connectors/warm and batch execution endpoints.
# This binding is conditional on var.enabled because the Cloud Run resource must
# exist before the IAM binding can be applied.

resource "google_cloud_run_v2_service_iam_member" "platform_backend_invoker" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.connector_service[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.platform_backend_sa_email}"
}
