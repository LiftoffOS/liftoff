# governance-engine: Governance Engine Cloud Run deployment scaffold
# Phase 3 — Governance Engine infrastructure
#
# What this module provisions:
#   1. Service account for the Governance Engine Cloud Run service
#   2. Cloud SQL instance `governance-pg` (postgres) for governance state
#      (action ledger / WAL drain sink, kill switches, policy cache, preflight
#      token revocation list)
#   3. Cloud Run service `governance-engine` (conditional on var.enabled)
#   4. IAM: Platform Backend SA → invoker on the Governance Engine
#   5. Secret Manager secretAccessor for the Governance Engine SA (all
#      governance-* secrets in the same project)
#
# The Cloud Run service and Cloud SQL resources are gated behind var.enabled.
# This allows the module to be wired into platform-control environments before
# the Governance Engine repo and container image exist, so per-tenant IAM grants
# (via the governance-iam module) can reference the SA email immediately.
#
# Unlike connector-service, the Governance Engine does NOT read per-tenant
# secrets — it owns its own database for the action ledger, policies, and
# kill-switch state. The Secret Manager access here is scoped to
# governance-* secrets (e.g. governance-pg-password, governance-engine-token,
# governance-preflight-signing-key) within its own project.
#
# Resource naming follows the liftoff-{purpose}-{env} convention.
#
# TODO before enabling:
#   - Set var.enabled = true once the governance-engine container image is
#     published to Artifact Registry.
#   - Confirm var.network_id points at the VPC used by other platform-control
#     services (Cloud SQL uses private IP on this network).
#   - Review db_tier: db-custom-2-4096 is a starting point; resize based on
#     action-ledger ingest load.
#   - Wire governance-iam module for each dedicated tenant with this SA email.

locals {
  # Matches the platform convention: plain service name, env-scoped by the
  # GCP project. SA gets the env suffix.
  service_name     = "governance-engine"
  sa_account_id    = "governance-engine-${var.environment}"
  sa_display_name  = "Governance Engine — ${var.environment}"
  db_instance_name = "governance-pg-${var.environment}"

  private_network = var.network_id != "" ? var.network_id : "projects/${var.project_id}/global/networks/default"

  labels = {
    environment = var.environment
    managed-by  = "terraform"
    service     = "governance-engine"
  }
}

# ─── Service Account ───────────────────────────────────────────────────────────
# The Governance Engine Cloud Run service runs as this SA.
# Created unconditionally — needed by governance-iam module for per-tenant
# invoker grants before the Cloud Run service itself is deployed.

resource "google_service_account" "governance_engine" {
  project      = var.project_id
  account_id   = local.sa_account_id
  display_name = local.sa_display_name
  description  = "Service account for the Governance Engine Cloud Run service (${var.environment})"
}

# Cloud Run evaluates Secret Manager IAM against the canonical resource
# name, which uses the project NUMBER (not project ID). Mirror the
# connector-service fix so both the project-ID and project-NUMBER forms
# match the IAM Condition CEL expression.
data "google_project" "self" {
  project_id = var.project_id
}

# ─── Cloud SQL client role for the Governance Engine SA ───────────────────────
# The SA is used by both the Cloud Run service and the migrate Cloud Run Job.
# Cloud Run's Cloud SQL Auth Proxy sidecar authenticates as this SA to open
# the Unix socket at /cloudsql/<instance>. Without roles/cloudsql.client the
# socket file is never created.

resource "google_project_iam_member" "governance_engine_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.governance_engine.email}"
}

# ─── Secret Manager access for the Governance Engine SA ───────────────────────
# Scoped via IAM Condition to governance-* secrets only. These live in the
# same platform-control project (governance doesn't fan out to per-tenant
# Secret Manager projects because it owns its own DB).

resource "google_project_iam_member" "governance_engine_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.governance_engine.email}"

  condition {
    title       = "governance-secrets-only-${var.environment}"
    description = "Restrict Governance Engine SA to governance-* secrets only"
    # Match both the project-ID form (gcloud display path) and the project-
    # NUMBER form (canonical Cloud Run evaluation).
    expression = <<-EOT
      resource.name.startsWith("projects/${var.project_id}/secrets/governance-") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/governance-")
    EOT
  }
}

# ─── Pub/Sub publisher role for the Governance Engine SA ──────────────────────
# The Governance Engine publishes kill-switch-changed events so tenant-runtime
# subscribers can evict their preflight cache in <5s (see plan §3e). The topic
# itself is created in the parent project config; this grants publish rights.

resource "google_project_iam_member" "governance_engine_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.governance_engine.email}"
}

# Cloud Trace + Logs (standard Cloud Run SA permissions)
resource "google_project_iam_member" "governance_engine_trace" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.governance_engine.email}"
}

resource "google_project_iam_member" "governance_engine_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.governance_engine.email}"
}

# ─── Cloud SQL: governance-pg ─────────────────────────────────────────────────
# Governance Engine database for the action ledger (WAL drain sink),
# kill-switch state, policy cache, and preflight token revocation list.
#
# Created UNCONDITIONALLY. The DB must exist before cloudbuild.yaml can run
# its migration job on the first push to liftoff-governance-engine main.
# Same decoupling rationale as connector-pg.

# governance_engine lives on control-plane-pg rather than its own instance, to cut idle
# cost. The database, governance_app and the BYPASSRLS admin role there are created
# outside Terraform when the database is moved; take a final backup before
# deleting the old instance. State forgets these three without destroying anything.
removed {
  from = google_sql_database_instance.governance_pg
  lifecycle {
    destroy = false
  }
}

removed {
  from = google_sql_database.governance_pg_db
  lifecycle {
    destroy = false
  }
}

removed {
  from = google_sql_user.governance_app
  lifecycle {
    destroy = false
  }
}

# ─── Cloud Run: Governance Engine ─────────────────────────────────────────────
# The Governance Engine Cloud Run deployment.
# Conditional on var.enabled — set to true once the container image is published.

resource "google_cloud_run_v2_service" "governance_engine" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = local.service_name
  location = var.region

  # Accept calls from cross-project callers (tenant-runtime in
  # YOUR_TENANT_PROJECT, platform-backend). Auth is enforced at the app
  # layer (GOVERNANCE_SERVICE_TOKEN bearer + signed preflight tokens) and
  # at the IAM layer via run.invoker bindings in governance-iam.
  ingress = "INGRESS_TRAFFIC_ALL"

  labels = local.labels

  template {
    labels = local.labels

    service_account = google_service_account.governance_engine.email

    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      # min_instance_count = 1 — governance is on the revenue path. A cold
      # start on authorize would add 1-3s to every cold tool call. See plan
      # §3e performance requirements (p95 < 3ms authorize).
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    timeout = "300s"

    max_instance_request_concurrency = 80

    dynamic "vpc_access" {
      for_each = var.vpc_network_id != "" ? [1] : []
      content {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
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
        name  = "GCP_PROJECT_ID"
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
        value = "governance_engine"
      }

      env {
        name  = "DB_USER"
        value = "governance_app"
      }

      # Pub/Sub topic for governance events (plan §3e). Single multiplexed
      # topic — the specific event type (kill_switch_changed, etc.) is
      # carried on the `eventType` message attribute so subscribers can
      # filter. Env var name is kept for backwards compatibility with the
      # existing publisher code; value now points at the renamed topic.
      env {
        name  = "PUBSUB_TOPIC_KILL_SWITCH_CHANGED"
        value = "governance-events-${var.environment}"
      }

      # Event type emitted by the kill-switch publisher path, attached to
      # each Pub/Sub message as the `eventType` attribute. Subscribers
      # filter on this to demultiplex the shared topic.
      env {
        name  = "PUBSUB_EVENT_TYPE_KILL_SWITCH_CHANGED"
        value = "governance.kill_switch_changed"
      }

      # Additional caller-supplied env vars (SENTRY_DSN, OTEL_EXPORTER_OTLP_ENDPOINT, etc.)
      dynamic "env" {
        for_each = var.env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      # Secrets from Secret Manager. The "name" here is the ENV VAR exposed
      # to the container (e.g. GOVERNANCE_SERVICE_TOKEN), while "secret_name"
      # is the underlying Secret Manager resource (e.g. governance-engine-token —
      # kept under its original name for non-breaking rollout).
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
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  # Terraform bootstraps the service and owns platform-wide concerns (project,
  # service account, Cloud SQL, VPC, ingress). The governance-engine repo's
  # cloudbuild.yaml owns per-deploy runtime config (image, env vars, scaling,
  # resources, timeout, probes) via `gcloud run deploy`. Without these
  # ignore_changes, every infrastructure-apply reverts runtime config back to
  # module defaults and silently drops env vars cloudbuild sets.
  lifecycle {
    ignore_changes = [
      template[0].annotations,
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].containers[0].resources,
      template[0].containers[0].liveness_probe,
      template[0].containers[0].startup_probe,
      template[0].scaling,
      template[0].timeout,
      template[0].max_instance_request_concurrency,
    ]
  }
}

# ─── IAM: Platform Backend → Governance Engine invoker ────────────────────────
# The Platform Backend SA is granted roles/run.invoker on the Governance
# Engine so it can call policy-management + read endpoints.
# Conditional on var.enabled because the Cloud Run resource must exist.

resource "google_cloud_run_v2_service_iam_member" "platform_backend_invoker" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.governance_engine[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.platform_backend_sa_email}"
}

# ─── Reconciliation Cloud Run Job + Cloud Scheduler ───────────────────────────
# Phase 3 plan verification: "Reconciliation script compares both data sets
# nightly". Runs the WAL-vs-governance-pg drift check on a schedule so drift
# between the tenant-runtime local WAL (post-write durability) and the
# governance-engine ledgers (durable source of truth for compliance) is
# caught within 24 hours.
#
# Composition:
#   1. Cloud Run Job `governance-reconciliation` — executes the reconcile
#      script using the same image as the main service (re-use avoids image
#      drift between the service and its maintenance jobs).
#   2. Cloud Scheduler `governance-reconciliation` — nightly HTTP trigger
#      that invokes the job via the Cloud Run Admin API, authenticated with
#      an OIDC token minted for the governance-engine SA.
#
# Both are gated behind `var.reconciliation_enabled && var.enabled`. When
# enabled=false the Cloud Run service doesn't exist and the image path isn't
# live, so provisioning the job + scheduler would race the first deploy.

locals {
  reconciliation_enabled = var.enabled && var.reconciliation_enabled
  reconciliation_job     = "governance-reconciliation-${var.environment}"
}

resource "google_cloud_run_v2_job" "governance_reconciliation" {
  count = local.reconciliation_enabled ? 1 : 0

  project  = var.project_id
  name     = local.reconciliation_job
  location = var.region

  labels = merge(local.labels, { role = "reconciliation" })

  template {
    labels = local.labels

    template {
      service_account = google_service_account.governance_engine.email

      # governance-pg is private IP only, so the Cloud SQL socket mounted below
      # is not on its own a route to it.
      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      # Reconciliation is a one-shot batch job; bound wall clock to 30min so
      # a stuck run surfaces as a visible failure rather than a perpetual
      # execution. Increase if drift volumes grow.
      timeout     = "1800s"
      max_retries = 1

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [var.sql_connection_name]
        }
      }

      containers {
        image = var.image

        # Override the default entrypoint to run the reconcile script.
        # Baked into the service image so job + service stay in lockstep.
        command = ["node"]
        args    = ["dist/jobs/reconcile/reconcile-wal-vs-governance.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }

        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }

        env {
          name  = "DB_INSTANCE_CONNECTION_NAME"
          value = var.sql_connection_name
        }

        env {
          name  = "DB_NAME"
          value = "governance_engine"
        }

        env {
          name  = "DB_USER"
          value = "governance_app"
        }

        # Same secrets as the service; reconcile needs the DB password +
        # the service token to call governance-engine's own read
        # endpoints for any cross-check it chooses to do over the network.
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

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  # Cloudbuild owns the image AND the environment; terraform owns the shell
  # (service account, VPC, Cloud SQL mount, timeouts, the scheduler).
  #
  # env was added to this list after the two owners spent a deploy reverting
  # each other. The reconcile script needs RECONCILE_TENANT_RUNTIME_URL, which
  # terraform cannot supply from here: the URL is an output of the
  # tenant-runtime-template module, and that module already consumes
  # platform-control's outputs, so wiring it back would close a dependency
  # cycle. Cloudbuild resolves it at deploy time with `gcloud run services
  # describe` instead, which cannot cycle and cannot go stale.
  #
  # The failure this prevents is quiet: terraform reverted the job's env on the
  # next infra apply, the job kept its image and stayed Ready=True, and the
  # only symptom was the nightly run exiting 2 on missing arguments — in a job
  # that had never succeeded anyway, so nothing looked different.
  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      template[0].template[0].containers[0].env,
    ]
  }
}

# Cloud Scheduler service account — reused across governance module
# schedulers (currently only reconciliation; easy to add more).
resource "google_service_account" "governance_scheduler" {
  count = local.reconciliation_enabled ? 1 : 0

  project      = var.project_id
  account_id   = "governance-sched-${var.environment}"
  display_name = "Governance Scheduler — ${var.environment}"
  description  = "Invokes governance-engine maintenance jobs on a cron schedule"
}

# Scheduler needs roles/run.invoker on the job it triggers.
resource "google_cloud_run_v2_job_iam_member" "governance_reconciliation_invoker" {
  count = local.reconciliation_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.governance_reconciliation[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.governance_scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "governance_reconciliation" {
  count = local.reconciliation_enabled ? 1 : 0

  project     = var.project_id
  region      = var.region
  name        = "governance-reconciliation-${var.environment}"
  description = "Nightly reconciliation: diffs tenant-runtime WAL vs governance-pg"
  schedule    = var.reconciliation_schedule
  time_zone   = var.reconciliation_time_zone

  http_target {
    # Cloud Run Admin API — `:run` on a v2 job resource kicks off one
    # execution. Scheduler auths as governance-scheduler-SA, which has
    # run.invoker on the job (binding above).
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.governance_reconciliation[0].name}:run"

    oauth_token {
      service_account_email = google_service_account.governance_scheduler[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count          = 2
    min_backoff_duration = "300s"
    max_backoff_duration = "3600s"
  }
}

# ─── Partition management Cloud Run Job + Cloud Scheduler ─────────────────────
# Migration 001 pre-creates 18 monthly partitions for `actions` and
# `usage_events`. Without automation we start returning write errors in
# 2027-10. This job runs monthly to:
#   - create the current + next 3 months of partitions (idempotent)
#   - detach + drop any partition older than 18 months (retention)
# Pure-native DDL (no pg_partman dep); partition count is predictable and
# small (48 rows / year across both tables).
#
# Gating: `partition_management_enabled` defaults true, but has no effect
# unless var.enabled = true (we need the service image).

locals {
  partition_management_enabled = var.enabled && var.partition_management_enabled
  partition_job                = "governance-partitions-${var.environment}"
}

# The partition-maintenance Cloud Run Job is created by the governance-engine
# repo's cloudbuild, not here — the same split the agent-scheduler-audit job
# uses. Terraform owning the job as well meant two writers for one resource:
# cloudbuild pinned it to the commit SHA while terraform kept setting a
# `governance-engine:${var.environment}` tag that cloudbuild has never written,
# so an apply would fail on "Image not found" and any execution in between died
# the same way. The scheduler and its invoker binding stay here and reference
# the job by name.
locals {
  governance_partitions_job_name = "governance-partitions-${var.environment}"
}

# Reuse the reconciliation scheduler SA when possible, else create one.
# We always create a dedicated SA if reconciliation is disabled so the
# job's IAM plane isn't entangled with reconciliation's lifecycle.
resource "google_service_account" "governance_partitions_scheduler" {
  count = local.partition_management_enabled && !local.reconciliation_enabled ? 1 : 0

  project      = var.project_id
  account_id   = "governance-part-sched-${var.environment}"
  display_name = "Governance Partitions Scheduler — ${var.environment}"
  description  = "Invokes governance-partitions Cloud Run Job on a cron schedule"
}

locals {
  partition_scheduler_sa_email = local.partition_management_enabled ? (
    local.reconciliation_enabled
    ? google_service_account.governance_scheduler[0].email
    : google_service_account.governance_partitions_scheduler[0].email
  ) : ""
}

resource "google_cloud_run_v2_job_iam_member" "governance_partitions_invoker" {
  count = local.partition_management_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = local.governance_partitions_job_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.partition_scheduler_sa_email}"
}

resource "google_cloud_scheduler_job" "governance_partitions" {
  count = local.partition_management_enabled ? 1 : 0

  project     = var.project_id
  region      = var.region
  name        = "governance-partitions-${var.environment}"
  description = "Monthly partition rotation for governance-pg (actions, usage_events)"
  schedule    = var.partition_schedule
  time_zone   = var.partition_time_zone

  http_target {
    # Cloud Run Admin API — `:run` on a v2 job resource kicks off one
    # execution. Scheduler auths as the partition scheduler SA, which
    # has run.invoker on the job (binding above).
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${local.governance_partitions_job_name}:run"

    oauth_token {
      service_account_email = local.partition_scheduler_sa_email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count          = 2
    min_backoff_duration = "300s"
    max_backoff_duration = "3600s"
  }
}
