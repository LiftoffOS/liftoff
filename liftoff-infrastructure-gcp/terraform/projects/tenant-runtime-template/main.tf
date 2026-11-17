# Tenant Runtime Project Template
# Pattern: tenant-<id>-runtime
# Each tenant gets a dedicated project with its own Cloud SQL database

variable "org_id" {
  type = string
}

variable "billing_account" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "display_name_override" {
  description = <<-EOT
    Console display name for the tenant project. Empty derives the usual
    "Tenant <id> Runtime <env>".

    DO NOT set this on a project that already exists and is serving traffic.

    Changing `google_project.name` makes Terraform unable to read
    `data.google_project.tenant_runtime_for_pubsub` at plan time, so every
    Pub/Sub IAM member whose `member` is derived from the project NUMBER becomes
    "known after apply" -- and `member` is ForceNew. A display-name change
    alone plans a destroy and re-add of every one of those bindings: the
    control-plane push-subscriber and DLQ-publisher bindings. The project
    number never actually changes, so the bindings are recreated identically,
    but there is a window with no permission on the event-delivery path. That
    is not a trade worth making for a console label on a live project.

    Safe at project CREATION, where there is nothing to churn.
  EOT
  type        = string
  default     = ""

  # GCP's own constraint on a project display name, encoded here so a bad value
  # fails at validate/plan with a message that says what is wrong. The provider
  # enforces it only at plan time, inside CI, and its own error does not name
  # the variable that produced the value. Parentheses are NOT permitted, which
  # is the non-obvious half: "Liftoff Shared Runtime Pool (dev)" was rejected
  # for the brackets as much as for its length.
  validation {
    condition = var.display_name_override == "" || (
      length(var.display_name_override) >= 4 &&
      length(var.display_name_override) <= 30 &&
      can(regex("^[A-Za-z0-9'\"! -]+$", var.display_name_override))
    )
    error_message = "display_name_override must be 4-30 characters using only letters, numbers, hyphen, quotes, space or exclamation point. Parentheses are NOT allowed."
  }
}

variable "tenant_id" {
  description = "Unique tenant identifier"
  type        = string
}

variable "slack_bot_token" {
  description = "Slack Bot OAuth Token for alert notifications"
  type        = string
  default     = ""
  sensitive   = true
}

variable "sandbox_sidecar_image" {
  description = "Container image URI for the sandbox sidecar (execution environment)"
  type        = string
  default     = ""
}

variable "platform_backend_sa" {
  description = "Platform Backend service account email for cross-project Cloud Run invocation"
  type        = string
  default     = ""
}

variable "harvest_sa" {
  description = "Harvest service SA email. When set, grants roles/run.invoker so harvest can write memories to this tenant's runtime services."
  type        = string
  default     = ""
}

variable "diagnostics_sa" {
  description = "Agent-diagnostics job SA email override. Normally left empty: when diagnostics_harvest_enabled is true (the default) the template derives the well-known agent-diagnostics-<env> SA and grants it run.invoker on agent-service, so fleet eval harvest is DEFAULT for every tenant with no per-tenant enrollment. Set this only to point a tenant at a non-standard diagnostics SA."
  type        = string
  default     = ""
}

variable "diagnostics_harvest_enabled" {
  description = "When true (default), grant the well-known agent-diagnostics-<env> SA run.invoker on this tenant's agent-service so the fleet eval harvest can reach its /harvest endpoint. Set false in environments that have no agent-diagnostics job/SA (e.g. staging), where the grant would reference a non-existent member and fail apply."
  type        = bool
  default     = true
}

locals {
  # Fleet eval harvest is default-on: unless an explicit override is given, derive the
  # well-known control-plane diagnostics SA for this environment. Empty (no grant) only when
  # harvest is disabled AND no override is set — keeps envs without the SA (staging) safe.
  diagnostics_sa_effective = var.diagnostics_sa != "" ? var.diagnostics_sa : (
    var.diagnostics_harvest_enabled ? "agent-diagnostics-${var.environment}@YOUR_GCP_PROJECT${var.environment}.iam.gserviceaccount.com" : ""
  )
}

variable "connector_service_enabled" {
  description = <<-EOT
    Whether to wire per-tenant IAM for the Connector Service.
    When true, the module creates:
      - roles/run.invoker on the Connector Service Cloud Run service for
        the tenant's tenant-runtime SA
      - roles/secretmanager.secretAccessor on connector-{tenantId}-*
        secrets for the Connector Service SA (scoped via IAM Condition)
  EOT
  type        = bool
  default     = false
}

variable "connector_service_project_id" {
  description = "GCP project ID hosting the Connector Service (typically YOUR_GCP_PROJECT<env>)."
  type        = string
  default     = ""
}

# Platform-control project hosting the central metric scope, Layer B auditor,
# and Layer D disagreement-emitter. The Layer A reconciler in each tenant-
# runtime project writes metrics that are visible from this project (via
# google_monitoring_monitored_project), and the auditor's SA lives here.
# Override the default only if the platform-control project diverges from
# the standard `YOUR_GCP_PROJECT<env>` naming convention.
variable "platform_control_project_id_override" {
  description = "Optional override for the platform-control project ID. Empty (default) computes it from var.environment as YOUR_GCP_PROJECT<env>."
  type        = string
  default     = ""
}

locals {
  platform_control_project_id = var.platform_control_project_id_override != "" ? var.platform_control_project_id_override : "YOUR_GCP_PROJECT${var.environment}"
}

variable "connector_service_url" {
  description = "Cloud Run URL of the Connector Service. Empty until deployed."
  type        = string
  default     = ""
}

variable "connector_service_sa_email" {
  description = "Email of the Connector Service SA (always populated by module.connector_service)."
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Governance Engine variables (Phase 3)
# -----------------------------------------------------------------------------

variable "governance_service_enabled" {
  description = <<-EOT
    Whether to wire per-tenant IAM for the Governance Engine.
    Naming convention: the variable is named `governance_service_enabled`
    (service-centric), distinct from the project-level
    `governance_engine_enabled` in platform-control/main.tf which controls
    whether the Cloud Run + SQL live resources are created.

    When true, the module creates:
      - roles/run.invoker on the Governance Engine Cloud Run service for
        the tenant's tenant-runtime SA
      - roles/secretmanager.secretAccessor on the shared
        governance-engine-token secret so the runtime can load the bearer
        token (exposed as GOVERNANCE_SERVICE_TOKEN env var) at startup
  EOT
  type        = bool
  default     = false
}

variable "governance_engine_project_id" {
  description = "GCP project ID hosting the Governance Engine (typically YOUR_GCP_PROJECT<env>)."
  type        = string
  default     = ""
}

variable "governance_engine_url" {
  description = "Cloud Run URL of the Governance Engine. Empty until deployed."
  type        = string
  default     = ""
}

variable "governance_engine_sa_email" {
  description = "Email of the Governance Engine SA (always populated by module.governance_engine)."
  type        = string
  default     = ""
}

# Cloudflare zone owning example.com — used by anchor_webhook_receiver_domain.tf
# to publish the CNAME for the receiver's custom hostname. Same zone as the
# tunnel-service records under platform-control.
variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for example.com. Required so the anchor-webhook-receiver custom domain (anchor-webhooks{,-dev}.example.com) can be wired without manual Cloudflare edits."
  type        = string
  default     = ""
}

locals {
  # Tenant project naming: tenant-<id>-<env>
  # Project IDs must be globally unique in GCP - use descriptive tenant IDs
  project_id = "tenant-${var.tenant_id}-${var.environment}"
}

resource "google_project" "tenant_runtime" {
  # Display name only. `project_id` is immutable in GCP, so a project whose id
  # no longer describes what it holds can still SAY what it holds. The console
  # is where an operator forms their mental model, and a shared pool sitting
  # under a name that reads as one tenant's private project misleads them.
  # Updates in place; nothing is recreated.
  name            = var.display_name_override != "" ? var.display_name_override : "Tenant ${var.tenant_id} Runtime ${var.environment}"
  project_id      = local.project_id
  org_id          = var.org_id
  billing_account = var.billing_account

  lifecycle {
    # CRITICAL: Never delete tenant projects - they contain customer data
    prevent_destroy = true
  }
}

# Enable required APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "pubsub.googleapis.com",
    "cloudtasks.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "aiplatform.googleapis.com",
    "storage.googleapis.com",
    "compute.googleapis.com",
    "vpcaccess.googleapis.com",
    "servicenetworking.googleapis.com",
  ])

  project = google_project.tenant_runtime.project_id
  service = each.value
}

# -----------------------------------------------------------------------------
# Data sources
# -----------------------------------------------------------------------------

moved {
  from = module.cloud_sql
  to   = module.cloud_sql[0]
}

# The tenant's Cloud SQL instance is created outside this Terraform — by the
# tenant-runtime cloudbuild.yaml `create-migrate-job` step using `gcloud sql
# instances create` — because Cloud SQL creation is slow (~20 min) and should
# only happen on first-tenant-deploy rather than every TF apply. We look the
# instance up as a data source so downstream resources (psql break-glass job,
# observability dashboards) can reference its private IP without hardcoding.
data "google_sql_database_instance" "tenant_pg" {
  count = var.control_pg_psc_enabled ? 0 : 1

  name    = "tenant-${var.tenant_id}-pg-${var.environment}"
  project = google_project.tenant_runtime.project_id

  depends_on = [google_project_service.apis]
}

# -----------------------------------------------------------------------------
# VPC Network Configuration
# Per Section 2: Tenant isolation with dedicated networking
# -----------------------------------------------------------------------------

# VPC Network for tenant
resource "google_compute_network" "tenant_vpc" {
  project                 = google_project.tenant_runtime.project_id
  name                    = "tenant-${var.tenant_id}-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.apis]
}

# Primary subnet for Cloud Run and other workloads
resource "google_compute_subnetwork" "tenant_subnet" {
  project       = google_project.tenant_runtime.project_id
  name          = "tenant-${var.tenant_id}-subnet"
  ip_cidr_range = "10.0.0.0/20"
  region        = var.region
  network       = google_compute_network.tenant_vpc.id

  private_ip_google_access = true

  # No flow logs. With Direct VPC egress every Cloud Run instance and sandbox
  # sends from this subnet, and half of all flows with full metadata was a log
  # ingestion bill for traffic nobody reads.
}

# The serverless VPC connector (and its /28 subnet) is gone: services, jobs and
# sandboxes use Direct VPC egress on tenant_subnet, which needs no instances.

# Private IP range for Cloud SQL
resource "google_compute_global_address" "private_ip_range" {
  project       = google_project.tenant_runtime.project_id
  name          = "tenant-${var.tenant_id}-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.tenant_vpc.id

  depends_on = [google_project_service.apis]
}

# Service Networking Connection for Cloud SQL private IP
resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.tenant_vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_range.name]

  depends_on = [google_project_service.apis]
}

# Cloud Router for NAT
resource "google_compute_router" "router" {
  project = google_project.tenant_runtime.project_id
  name    = "tenant-${var.tenant_id}-router"
  region  = var.region
  network = google_compute_network.tenant_vpc.id

  depends_on = [google_project_service.apis]
}

# Cloud NAT for outbound internet access
resource "google_compute_router_nat" "nat" {
  project                            = google_project.tenant_runtime.project_id
  name                               = "tenant-${var.tenant_id}-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}

# -----------------------------------------------------------------------------
# Firewall Rules
# Per Section 20: Defense in depth
# -----------------------------------------------------------------------------

# Allow internal traffic within the VPC
resource "google_compute_firewall" "allow_internal" {
  project = google_project.tenant_runtime.project_id
  name    = "tenant-${var.tenant_id}-allow-internal"
  network = google_compute_network.tenant_vpc.name

  allow {
    protocol = "tcp"
    ports    = ["0-65535"]
  }
  allow {
    protocol = "udp"
    ports    = ["0-65535"]
  }
  allow {
    protocol = "icmp"
  }

  source_ranges = ["10.0.0.0/8"]

  depends_on = [google_project_service.apis]
}

# Deny all ingress by default
resource "google_compute_firewall" "deny_all_ingress" {
  project  = google_project.tenant_runtime.project_id
  name     = "tenant-${var.tenant_id}-deny-all-ingress"
  network  = google_compute_network.tenant_vpc.name
  priority = 65534

  deny {
    protocol = "all"
  }

  source_ranges = ["0.0.0.0/0"]

  depends_on = [google_project_service.apis]
}

# Allow health checks from GCP load balancers
resource "google_compute_firewall" "allow_health_checks" {
  project = google_project.tenant_runtime.project_id
  name    = "tenant-${var.tenant_id}-allow-health-checks"
  network = google_compute_network.tenant_vpc.name

  allow {
    protocol = "tcp"
    ports    = ["80", "443", "8080"]
  }

  # GCP health check IP ranges
  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]

  target_tags = ["allow-health-check"]

  depends_on = [google_project_service.apis]
}

# Cloud SQL for PostgreSQL - Tenant Database
# Per Section 1: "one Cloud SQL PostgreSQL instance per environment with a dedicated database per tenant"
module "cloud_sql" {
  # The runtime's database is on control-plane-pg (control_db_psc.tf). The
  # final state of this instance is the cutover export in
  # gs://YOUR_GCP_PROJECT/cutover/ (kept 30 days).
  count  = var.control_pg_psc_enabled ? 0 : 1
  source = "../../modules/cloud-sql"

  project_id  = google_project.tenant_runtime.project_id
  region      = var.region
  environment = var.environment
  name_prefix = "tenant-${var.tenant_id}"

  # Shared-core while the platform has no traffic (30-day peak 47 backends).
  # db-g1-small carries no SLA; raise both together when agents need it.
  tier            = "db-g1-small"
  max_connections = 100

  # The runtime's database moved to control-plane-pg (control_db_psc.tf); this
  # instance is retired once its final backup is taken.
  deletion_protection = !var.control_pg_psc_enabled

  # Private networking
  network_id           = google_compute_network.tenant_vpc.id
  private_network_name = google_compute_network.tenant_vpc.name

  depends_on = [
    google_project_service.apis,
    google_service_networking_connection.private_vpc_connection
  ]
}

# -----------------------------------------------------------------------------
# Cloud Run Services
# Cloud Run services — scaled for uncapped agent workloads
# -----------------------------------------------------------------------------

# R5 Fix 8: framer-secret for UntrustedContentFramer HMAC derivation.
# 256-bit random, rotated every 90 days via Cloud Scheduler (below).
resource "google_secret_manager_secret" "framer_secret" {
  secret_id = "framer-secret"
  project   = google_project.tenant_runtime.project_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# Initial secret version: 32 bytes of random, generated at apply time.
# Rotation is handled operationally (Cloud Scheduler reminder + manual rotate runbook).
resource "random_id" "framer_secret_initial" {
  byte_length = 32
}

resource "google_secret_manager_secret_version" "framer_secret_initial" {
  secret      = google_secret_manager_secret.framer_secret.id
  secret_data = random_id.framer_secret_initial.b64_std

  lifecycle {
    ignore_changes = [secret_data] # Subsequent rotations managed outside TF
  }
}

# Grant the tenant-runtime SA access to read framer-secret.
resource "google_secret_manager_secret_iam_member" "framer_secret_access" {
  secret_id = google_secret_manager_secret.framer_secret.id
  project   = google_project.tenant_runtime.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${module.iam.tenant_runtime_sa}"
}

# -----------------------------------------------------------------------------
# Sandbox Execution Environment Service
# Ephemeral compute for agents that need shell access, file operations, git.
# Uses gen2 (gVisor) for security isolation. Internal ingress only.
# The sidecar image exposes /exec, /readFile, /writeFile HTTP endpoints.
# -----------------------------------------------------------------------------

resource "google_service_account" "sandbox_executor" {
  project      = google_project.tenant_runtime.project_id
  account_id   = "sandbox-executor"
  display_name = "Sandbox Executor Service Account"
  description  = "Minimal-privilege SA for sandbox execution environments"
}

# sandbox-executor: the per-tenant sandbox orchestrator Cloud Run service.
# Hosts CloudRunSandboxProvider + SandboxExecutor + InstanceAliveTicker + KMS
# envelope for per-sandbox JWT secrets.
#
# Runs the standard tenant-runtime image with SERVICE_TYPE=sandbox-executor;
# cloudbuild's `deploy-sandbox-executor` step owns the image + env vars at
# runtime, so this Terraform resource only declares the placeholder image and
# bootstrap config. The lifecycle.ignore_changes block below matches the other
# split services (agent / coordinator / tool-gateway / reflection in
# split_services.tf) so subsequent terraform applies don't fight cloudbuild.
#
# This service does not run the aio-sandbox (per-sandbox sidecar) image or
# embed the dynamic Envoy egress-proxy sidecar — the per-sandbox sidecar runs on
# dynamically created per-request Cloud Run services (one per sandbox), and the
# orchestrator doesn't need its own egress audit because its outbound calls are all
# GCP-internal (Cloud Run admin API, KMS, agent-service, tool-gateway, Cloud
# SQL via socket).
#
# The `module "sandbox_egress_proxy"` instantiation in sandbox_egress_proxy.tf
# still provisions the envoy.yaml GCS bucket and IAM, ready
# for a future plan that puts the audit proxy on the per-sandbox services. The
# orchestrator just doesn't consume it.
resource "google_cloud_run_v2_service" "sandbox_executor" {
  # Gated on var.split_services_deployed to match the four split services
  # (tool-gateway-service, agent-service, coordinator-service,
  # reflection-service). Off → monolith owns the sandbox subsystem in-process
  # (existing behavior). On → orchestrator runs here. Cloudbuild's
  # deploy-sandbox-executor step only fires on tenants where this flag is
  # true, so the trigger and the resource go live together.
  count = var.split_services_deployed ? 1 : 0

  project  = google_project.tenant_runtime.project_id
  name     = "sandbox-executor"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  labels = merge(local.split_service_labels, { service = "sandbox-executor" })

  template {
    # Cloud SQL annotation: declared in Terraform so brand-new tenants get
    # DB connectivity from the first plan, not only after cloudbuild's
    # --add-cloudsql-instances post-deploy patch. Phase 2 (provider + DB
    # writes) depends on this being live at boot.
    annotations = var.control_pg_psc_enabled ? {} : {
      "run.googleapis.com/cloudsql-instances" = module.cloud_sql[0].connection_name
    }

    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    service_account                  = google_service_account.sandbox_executor.email
    max_instance_request_concurrency = 80
    timeout                          = "600s"

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    vpc_access {

      network_interfaces {

        network = google_compute_network.tenant_vpc.id

        subnetwork = google_compute_subnetwork.tenant_subnet.id

      }
      egress = "ALL_TRAFFIC"
    }

    containers {
      # cloudbuild's deploy-sandbox-executor step sets the real image +
      # env vars. Terraform owns only the placeholder so this resource
      # plans cleanly on a brand-new tenant before the first cloudbuild
      # run has populated the actual image.
      image = local.split_service_placeholder_image

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      env {
        name  = "SERVICE_TYPE"
        value = "sandbox-executor"
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    module.iam,
  ]

  # Same pattern as the four split services in split_services.tf — Terraform
  # owns the service's existence + identity; cloudbuild's gcloud run deploy
  # carries the per-deploy image + env + secrets AND the runtime tuning
  # (scaling/concurrency/timeout/vpc) + the Cloud SQL mount, which it attaches
  # via --set-cloudsql-instances / --add-volume. ignore_changes covers exactly
  # what cloudbuild mutates so an infrastructure-apply never reverts it.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].containers[0].resources,
      template[0].containers[0].liveness_probe,
      template[0].containers[0].startup_probe,
      template[0].containers[0].volume_mounts,
      template[0].volumes,
      template[0].annotations,
      template[0].scaling,
      template[0].timeout,
      template[0].max_instance_request_concurrency,
      template[0].vpc_access,
      client,
      client_version,
    ]
  }
}

# No `sandbox_parity_phase` / `sandbox_parity_allowed_tenants` vars: neither
# is consumed by the sandbox-executor service. Cloudbuild's deploy-sandbox-executor step
# manages all sandbox-related env vars now. Re-add here only if a future plan
# brings back phase gating at the infrastructure layer.

# (P0.2) No `block_sandbox_metadata` EGRESS firewall (SE-003, SE-007) denying
# tcp/80,443 to 169.254.169.254/32. VPC egress firewalls CANNOT block Cloud
# Run's link-local metadata server (169.254.169.254) — an in-sandbox curl to it
# still succeeds. Such a rule is false assurance. Metadata-token protection is now the P0.1 least-privilege
# `sandbox-runtime` SA (sandbox_runtime_sa.tf): a stolen token is useless.

# No Cloud Scheduler job for sandbox-executor's GC sweep. The sweep (see
# sandbox-executor.ts `gcSweep`: finished cron/event runs, lapsed heartbeats,
# and Cloud Run services with no sandbox_state row) is armed as a maintenance
# Cloud Task when a sandbox is claimed and re-arms every ten minutes while any
# sandbox is live, and the daily housekeeping pass runs it as the backstop for
# orphans. On a fixed 6-hourly clock a finished run's sandbox, a pinned
# instance, would outlive it by up to six hours; armed this way, the sweep does
# not run at all while there are no sandboxes.
# The enqueue and actAs grants it needs are sandbox_executor_maintenance_enqueuer
# and sandbox_executor_act_as_scheduler below.

# Slack notification channel for tenant alert policies
resource "google_monitoring_notification_channel" "slack" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.tenant_runtime.project_id
  display_name = "Slack - Liftoff Platform Alerts"
  type         = "slack"

  labels = {
    channel_name = "#platform-observability-alerts"
  }

  sensitive_labels {
    auth_token = var.slack_bot_token
  }

  depends_on = [google_project_service.apis]
}

# Pub/Sub for workflow events
module "pubsub" {
  source = "../../modules/pubsub"

  project_id            = google_project.tenant_runtime.project_id
  environment           = var.environment
  tenant_id             = var.tenant_id
  notification_channels = var.slack_bot_token != "" ? [google_monitoring_notification_channel.slack[0].name] : []

  depends_on = [google_project_service.apis]
}

# -----------------------------------------------------------------------------
# Cloud SQL Connection Monitoring Alerts
# Fires when connection count approaches Cloud SQL max_connections limit
# -----------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "cloudsql_connections_warning" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Cloud SQL connections > 80% of max"
  combiner     = "OR"

  conditions {
    display_name = "Cloud SQL connection utilization high"
    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND metric.type = \"cloudsql.googleapis.com/database/postgresql/num_backends\""
      comparison      = "COMPARISON_GT"
      threshold_value = (var.environment == "prod" ? 400 : 200) * 0.8
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = var.slack_bot_token != "" ? [google_monitoring_notification_channel.slack[0].name] : []

  alert_strategy {
    auto_close = "1800s"
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "cloudsql_connections_critical" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Cloud SQL connections > 95% of max (CRITICAL)"
  combiner     = "OR"

  conditions {
    display_name = "Cloud SQL connection utilization critical"
    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND metric.type = \"cloudsql.googleapis.com/database/postgresql/num_backends\""
      comparison      = "COMPARISON_GT"
      threshold_value = (var.environment == "prod" ? 400 : 200) * 0.95
      duration        = "60s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = var.slack_bot_token != "" ? [google_monitoring_notification_channel.slack[0].name] : []

  alert_strategy {
    auto_close = "1800s"
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "cloudsql_cpu_high" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Cloud SQL CPU > 80% sustained"
  combiner     = "OR"

  conditions {
    display_name = "Cloud SQL CPU utilization high"
    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND metric.type = \"cloudsql.googleapis.com/database/cpu/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = var.slack_bot_token != "" ? [google_monitoring_notification_channel.slack[0].name] : []

  alert_strategy {
    auto_close = "1800s"
  }

  depends_on = [google_project_service.apis]
}

# -----------------------------------------------------------------------------
# Cross-Project Pub/Sub Subscriptions
# Subscriptions in tenant project that consume from control-plane topics
# This enables tenant-runtime to receive AI team events, external agent events, etc.
# -----------------------------------------------------------------------------

locals {
  # Control plane topics that tenant-runtime needs to subscribe to.
  # Event handlers for these live in src/events/subscriber.ts (SUBSCRIBED_EVENTS).
  # Keep this list in sync with that code — missing subscriptions crash the
  # runtime at boot with "Resource not found".
  control_plane_subscription_topics = [
    "control-plane-events",
    "tenant-entitlement-updated",
    "tenant-suspended",
    "tenant-reactivated",
    "tenant-deployment-approved",
    "tenant-model-config-updated",
    "tenant-prompt-bundle-updated",
    "tenant-feature-flag-updated",
  ]

  # Cloud Run secret env-var bindings for tenant runtime services.
  #
  # INTENTIONALLY EMPTY. The tenant runtime app loads its own secrets at
  # process startup via loadSecretsToEnv() in src/infrastructure/secrets.ts,
  # which fetches each entry in SECRET_MANIFEST from Secret Manager and
  # writes it to process.env. This means:
  #
  #   - Cloud Run binds NO secrets as env vars.
  #   - cloudbuild.yaml has no --set-secrets flag.
  #   - Terraform manages no env value_source secret_key_ref entries.
  #
  # Two ways of binding a secret (cloudbuild deploy and Terraform apply)
  # step on each other and wipe bindings the other tool set — e.g. a
  # cloudbuild deploy that omits TENANT_RUNTIME_SERVICE_TOKEN from
  # --set-secrets wipes it and takes the service down.
  #
  # The IAM grant that lets the runtime service accounts call Secret
  # Manager API at runtime is `secret_accessors` on `module.secret_manager`
  # below — that's the only Terraform-owned thing in this picture, and it's
  # an ACL not a binding, so cloudbuild has no reason to ever touch it.
  #
  # To add a new secret a tenant runtime service needs:
  #   1. Make sure it exists in the tenant project's Secret Manager
  #      (provisioning.ts populateTenantSecrets handles the standard ones)
  #   2. Append it to SECRET_MANIFEST in
  #      Liftoff-Tenant-Runtime/src/infrastructure/secrets.ts
  #   3. Deploy the runtime image — the loader picks it up at startup
  #
  # No Terraform change required.
  tenant_runtime_secrets = []
}

# NOTE: legacy monolith subscription `control_plane_cross_project` and its IAM
# binding, and the per-service split subscriptions in
# `control_plane_cross_project_split` (Phase 5), are removed — see
# pubsub_push.tf for the replacement push subs.
# The `removed` blocks for both generations live below + in
# agent_creation_resilience.tf so Terraform destroys any state-tracked
# instances on next apply.

# Grant tenant-runtime permission to view the source topic in control-plane project
# Required for cross-project subscription to work
resource "google_pubsub_topic_iam_member" "control_plane_topic_viewer" {
  for_each = toset(local.control_plane_subscription_topics)

  project = "YOUR_GCP_PROJECT${var.environment}"
  topic   = "${each.value}-${var.environment}"
  role    = "roles/pubsub.viewer"
  member  = "serviceAccount:${google_project.tenant_runtime.number}-compute@developer.gserviceaccount.com"
}

# -----------------------------------------------------------------------------
# Phase 5 push migration: control-plane events are delivered
# via Pub/Sub PUSH subscriptions (see pubsub_push.tf), not streaming pull. The
# per-service streaming-pull subscriptions (`control_plane_cross_project_split`)
# and their IAM bindings (`control_plane_subscriber_split`,
# `control_plane_dlq_subscriber_split` in agent_creation_resilience.tf) are
# being destroyed via the `removed{}` blocks below. See
# (coordinator scales to zero, streaming-pull subscriber dies, control-plane
# events queue until the next HTTP wakeup).
#
# Pattern matches the legacy monolith subscription removal in
# agent_creation_resilience.tf (the `removed{}` blocks for the legacy
# monolith subs).
# -----------------------------------------------------------------------------

removed {
  from = google_pubsub_subscription.control_plane_cross_project_split
  lifecycle { destroy = true }
}

removed {
  from = google_pubsub_subscription_iam_member.control_plane_subscriber_split
  lifecycle { destroy = true }
}

# Cloud Tasks for durable execution
module "cloud_tasks" {
  source = "../../modules/cloud-tasks"

  project_id  = google_project.tenant_runtime.project_id
  region      = var.region
  environment = var.environment
  tenant_id   = var.tenant_id
  # Pre-computed email so for_each key set is static on first apply
  service_account_email = "tenant-${var.tenant_id}-runtime@tenant-${var.tenant_id}-${var.environment}.iam.gserviceaccount.com"

  depends_on = [google_project_service.apis, module.iam]
}

# Secret Manager for connector credentials and shared platform secrets
module "secret_manager" {
  source = "../../modules/secret-manager"

  project_id  = google_project.tenant_runtime.project_id
  environment = var.environment

  # Pre-computed email so for_each key set is static on first apply
  secret_accessors = [
    "tenant-${var.tenant_id}-runtime@tenant-${var.tenant_id}-${var.environment}.iam.gserviceaccount.com",
  ]

  depends_on = [google_project_service.apis, module.iam]
}

# -----------------------------------------------------------------------------
# Cross-Project IAM: Allow Platform Backend to Write Connector Credentials
# Per Security Requirement: Tokens should be written directly to Secret Manager
# by the control plane, not transmitted via Pub/Sub
# -----------------------------------------------------------------------------

# Grant platform-backend SA permission to create/manage connector credential secrets
# This enables the OAuth callback to write tokens directly to tenant's Secret Manager
# Note: No IAM condition - tenant project isolation is the security boundary
resource "google_project_iam_member" "platform_backend_secret_admin" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:platform-backend-${var.environment}@YOUR_GCP_PROJECT${var.environment}.iam.gserviceaccount.com"

  depends_on = [
    google_project_service.apis,
    module.secret_manager
  ]
}

# -----------------------------------------------------------------------------
# Cross-project read on Liftoff-owned web-tool vendor keys
# -----------------------------------------------------------------------------
# webclaw / firecrawl / anchor / browserbase / browserbase-project-id are NOT
# tenant-scoped — same vendor account is billed regardless of which tenant
# agent invokes the call. Source-of-truth lives once per env in
# YOUR_GCP_PROJECT; the tenant runtime reads them cross-project
# via getWebToolSecret() in web-tool-secrets.ts. These IAM grants let this
# tenant's runtime SA do that read without copying the keys into every
# tenant project (the openai-api-key copy pattern is wrong for non-
# tenant-scoped secrets).
resource "google_secret_manager_secret_iam_member" "runtime_web_tool_keys" {
  for_each = toset([
    "perplexity-api-key",
    "openai-api-key",
    "google-api-key",
    # Browser Use is the platform's own agent browser: every team gets one
    # without connecting anything, the same way perplexity backs web research.
    # A workspace that connects its OWN Browser Use key on /connections keeps
    # using that instead — the runtime prefers the tenant credential and only
    # falls back here.
    "browser-use-api-key",
    # Steel is the platform's agent browser: usage-billed with auto top-up, so
    # it cannot silently run out of prepaid credit. Same two lanes
    # as Browser Use — a workspace's own Steel key on /connections wins, this
    # key backs every workspace that connected nothing. Browser Use stays as
    # the fallback vendor. Secret created by hand in both platform-control
    # projects, the established pattern.
    "steel-api-key",
    # TypeSafe (Jev): the runtime's browser loop, contract check, ask check,
    # message check and memory checks read the platform's one key through
    # getWebToolSecret('typesafe-api-key'). Managed in platform-control/main.tf
    # (google_secret_manager_secret.typesafe_api_key); the prod accessor
    # arrives with the infra release push, so the runtime phases promote with
    # it.
    "typesafe-api-key",
  ])

  project   = "YOUR_GCP_PROJECT${var.environment}"
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  # Each secret named in the for_each set above must exist in the
  # platform-control-{env} project BEFORE terraform apply — they are created
  # manually via `gcloud secrets create` (the established pattern;
  # openai-api-key and anthropic-api-key were bootstrapped this way too).
  # The secret-manager module at line 768 creates secrets in the TENANT
  # project, not in platform-control, so it cannot satisfy this cross-project
  # IAM grant dependency. New entries here require a pre-apply secret-create
  # step in both dev + prod platform-control; otherwise the grant fails on a
  # missing secret.
  member = "serviceAccount:tenant-${var.tenant_id}-runtime@${google_project.tenant_runtime.project_id}.iam.gserviceaccount.com"

  depends_on = [
    google_project_service.apis,
    module.iam,
  ]
}

# IAM with tenant-scoped service accounts per Section 20
module "iam" {
  source = "../../modules/iam"

  project_id  = google_project.tenant_runtime.project_id
  environment = var.environment
  tenant_id   = var.tenant_id

  depends_on = [google_project_service.apis]
}

# Per-tenant Connector Service IAM (Phase 1). Instantiates the
# scaffolded connector-iam module so the tenant-runtime SA can invoke
# the Connector Service, and the Connector Service SA gets
# secretmanager.secretAccessor scoped to connector-{tenantId}-* secrets
# in this tenant project.
module "connector_iam" {
  count  = var.connector_service_enabled ? 1 : 0
  source = "../../modules/connector-iam"

  tenant_id                    = var.tenant_id
  region                       = var.region
  connector_service_project_id = var.connector_service_project_id
  connector_service_url        = var.connector_service_url
  connector_service_sa_email   = var.connector_service_sa_email
  tenant_runtime_sa_email      = module.iam.tenant_runtime_sa
  secret_manager_project_id    = google_project.tenant_runtime.project_id

  depends_on = [module.iam, module.secret_manager]
}

# Per-tenant Governance Engine IAM (Phase 3). Parallel to connector_iam
# above — grants the tenant-runtime SA roles/run.invoker on the
# governance-engine Cloud Run service and access to the
# governance-engine-token shared bearer secret.
#
# Unlike connector-iam, this module does NOT grant the Governance Engine
# SA any rights in the tenant project — governance doesn't fan out to
# per-tenant Secret Manager because it owns its own database.
module "governance_iam" {
  count  = var.governance_service_enabled ? 1 : 0
  source = "../../modules/governance-iam"

  tenant_id                    = var.tenant_id
  region                       = var.region
  governance_engine_project_id = var.governance_engine_project_id
  governance_engine_url        = var.governance_engine_url
  governance_engine_sa_email   = var.governance_engine_sa_email
  tenant_runtime_sa_email      = module.iam.tenant_runtime_sa

  depends_on = [module.iam]
}

# -----------------------------------------------------------------------------
# Cloud Scheduler - Reflection Jobs
# Per Section 14: Scheduled reflection triggers for agent learning
# -----------------------------------------------------------------------------

# Enable Cloud Scheduler API
resource "google_project_service" "cloudscheduler" {
  project = google_project.tenant_runtime.project_id
  service = "cloudscheduler.googleapis.com"

  depends_on = [google_project_service.apis]
}

# Service account for scheduler jobs
resource "google_service_account" "scheduler" {
  project      = google_project.tenant_runtime.project_id
  account_id   = "tenant-${var.tenant_id}-scheduler"
  display_name = "Scheduler Service Account - Tenant ${var.tenant_id}"
  description  = "Service account for Cloud Scheduler jobs"

  depends_on = [google_project_service.apis]
}

# Allow scheduler to invoke Cloud Run services
resource "google_project_iam_member" "scheduler_invoker" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.scheduler.email}"

  depends_on = [google_service_account.scheduler]
}

# Platform Backend → agent-service invoker binding lives below at
# `platform_backend_agent_invoker` (§4f cutover target). The previous
# `platform_backend_invoker` binding targeted the `tenant-runtime` monolith
# Cloud Run service, which has been decommissioned.

# -----------------------------------------------------------------------------
# Phase 4: per-tenant IAM for the split tenant-runtime services
# -----------------------------------------------------------------------------
# The tenant-runtime Docker image is deployed as four additional Cloud Run
# services alongside the monolith: agent-service, coordinator-service,
# tool-gateway-service, reflection-service. Terraform doesn't own the Cloud
# Run resources themselves — they're deployed by cloudbuild.yaml, same pattern
# as the existing `tenant-runtime` service — but we do own the IAM so that:
#
#   1. All four services (running as tenant_runtime_sa) can invoke each other
#      across the intra-tenant call graph (agent → tool-gateway, etc.).
#   2. Platform Backend can invoke agent-service directly, once traffic is
#      shifted from the monolith (plan §4f step 2). Coordinator/tool-gateway/
#      reflection are intra-tenant only — INGRESS_TRAFFIC_INTERNAL_ONLY plus
#      the run.invoker binding below is enough to reach them.
#
# `split_services_deployed` mirrors `tenant_runtime_deployed` — flipped true
# only after the first cloudbuild trigger produces the four services.

variable "split_services_deployed" {
  description = <<-EOT
    Gate: true once the four split tenant-runtime services
    (agent-service, coordinator-service, tool-gateway-service, reflection-service)
    exist in the tenant project. Before that, `run.invoker` IAM bindings cannot
    resolve the service resource name. Flipped true on the first environment
    apply after cloudbuild deploys the services.
  EOT
  type        = bool
  default     = false
}

locals {
  split_services = ["agent-service", "coordinator-service", "tool-gateway-service", "reflection-service"]
}

# Intra-tenant: every split service's SA (tenant_runtime_sa) can invoke every
# other split service. Also bind to the monolith tenant-runtime so the new
# services can forward into legacy code paths during the rollout window.
resource "google_cloud_run_service_iam_member" "split_service_intra_invoker" {
  for_each = var.split_services_deployed ? toset(local.split_services) : []

  project  = google_project.tenant_runtime.project_id
  location = var.region
  service  = each.value
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.iam.tenant_runtime_sa}"

  # Explicit depends_on since `service` is a string, not a resource ref —
  # Terraform wouldn't otherwise know to wait for the Cloud Run v2 resources
  # declared in split_services.tf.
  depends_on = [
    google_cloud_run_v2_service.agent_service,
    google_cloud_run_v2_service.coordinator_service,
    google_cloud_run_v2_service.tool_gateway_service,
    google_cloud_run_v2_service.reflection_service,
  ]
}

# Cross-project: platform-backend-sa can invoke agent-service (the new
# invocation entry point). Matches the existing binding on tenant-runtime so
# that platform-backend keeps working through the monolith → agent-service
# cutover described in plan §4f step 2.
resource "google_cloud_run_service_iam_member" "platform_backend_agent_invoker" {
  count = var.platform_backend_sa != "" && var.split_services_deployed ? 1 : 0

  project  = google_project.tenant_runtime.project_id
  location = var.region
  service  = "agent-service"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.platform_backend_sa}"

  depends_on = [google_cloud_run_v2_service.agent_service]
}

# Cross-project: harvest-service SA can invoke agent-service to write memories.
# Required for dedicated-tenant runtimes in isolated GCP projects.
# Shared tenants use project-level IAM set in platform-control.
resource "google_cloud_run_service_iam_member" "harvest_agent_invoker" {
  count = var.harvest_sa != "" && var.split_services_deployed ? 1 : 0

  project  = google_project.tenant_runtime.project_id
  location = var.region
  service  = "agent-service"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.harvest_sa}"

  depends_on = [google_cloud_run_v2_service.agent_service]
}

# Cross-project: agent-diagnostics job SA can invoke agent-service to run the
# passive eval /harvest endpoint (user-created runs evaluate in-tenant — the DB
# and tool-gateway are tenant-local). Only the eval tenant sets diagnostics_sa.
resource "google_cloud_run_service_iam_member" "diagnostics_agent_invoker" {
  count = local.diagnostics_sa_effective != "" && var.split_services_deployed ? 1 : 0

  project  = google_project.tenant_runtime.project_id
  location = var.region
  service  = "agent-service"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.diagnostics_sa_effective}"

  depends_on = [google_cloud_run_v2_service.agent_service]
}

# Cross-project: the agent-diagnostics job (control plane) FANS OUT the durable
# collab deliverable grader by running the tenant `tenant-runtime-collab-grade`
# Cloud Run Job WITH a per-execution env override (the base64 worklist). Running
# a job WITH overrides needs run.jobs.runWithOverrides, which roles/run.invoker
# does NOT carry (that's why the override-less harvest scheduler can use invoker)
# — roles/run.developer does. Scoped to this one job. The job itself is created
# by the tenant-runtime cloudbuild `create-collab-grade-job` step (not a TF
# resource), so this binds by name; on a brand-new tenant it applies once that
# build has run. Only the eval tenant sets diagnostics_sa.
resource "google_cloud_run_v2_job_iam_member" "diagnostics_collab_grade_runner" {
  count = var.diagnostics_sa != "" && var.split_services_deployed ? 1 : 0

  project  = google_project.tenant_runtime.project_id
  location = var.region
  name     = "tenant-runtime-collab-grade"
  role     = "roles/run.developer"
  member   = "serviceAccount:${var.diagnostics_sa}"
}

# Break-glass psql access to the tenant database.
#
# Cloud SQL has only a private IP and the VPC is not reachable from operator
# laptops, so when something is on fire and we need to inspect or repair the
# database directly, there is no good path from outside the VPC. This Cloud
# Run job runs psql inside the VPC (Direct VPC egress → Cloud SQL private
# IP) and reads its SQL from the QUERY env var, which is overridden per
# execution:
#
#   gcloud run jobs execute tenant-runtime-psql \
#     --project=tenant-<tenant>-<env> --region=us-west1 \
#     --update-env-vars QUERY='SELECT id FROM connectors LIMIT 5;' \
#     --wait
#
# Output is in the job execution logs (Cloud Logging — filter by
# resource.labels.job_name="tenant-runtime-psql"). The job reuses the
# existing tenant-runtime-migrate image because it already has psql
# installed and the right credentials. The image tag is :latest and is
# resolved at job creation time; subsequent terraform applies do not
# update the image (see ignore_changes below) so the digest stays stable
# until someone explicitly bumps it.
#
# Cloud SQL Studio (Console → SQL → instance → Studio) is the other
# break-glass option for casual one-off queries from a browser. This job
# is the scriptable equivalent for runbooks, CI ops, and queries that
# don't fit in the console UI.
#
# WARNING: this job runs as the default compute SA, which has full
# project access. Anything you can express in SQL — including DROP TABLE
# — will be executed. Treat this like an ssh-to-prod tool.
resource "google_cloud_run_v2_job" "psql_break_glass" {
  project  = google_project.tenant_runtime.project_id
  location = var.region
  name     = "tenant-runtime-psql"

  template {
    template {
      service_account = "${google_project.tenant_runtime.number}-compute@developer.gserviceaccount.com"
      max_retries     = 0
      timeout         = "300s"

      vpc_access {

        network_interfaces {

          network = google_compute_network.tenant_vpc.id

          subnetwork = google_compute_subnetwork.tenant_subnet.id

        }
        egress = "ALL_TRAFFIC"
      }

      containers {
        image = "${var.region}-docker.pkg.dev/YOUR_GCP_PROJECT${var.environment}/YOUR_GCP_PROJECT${var.environment}/tenant-runtime-migrate:latest"

        # Override the migrate image's CMD with a one-shot psql call.
        # Bare "$VAR" passes through Terraform unchanged because Terraform
        # only interprets "$${...}" interpolation, not bare $ characters.
        # Bash expands the env vars at runtime inside the container.
        command = ["bash", "-c"]
        args = [
          <<-EOT
          set -e
          if [ -z "$QUERY" ]; then
            echo 'ERROR: QUERY env var is required.'
            echo 'Run with: gcloud run jobs execute tenant-runtime-psql --update-env-vars QUERY="SELECT ..."'
            exit 1
          fi
          echo "Running query: $QUERY"
          PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "$QUERY"
          EOT
        ]

        env {
          name = "DB_HOST"
          # Resolved, never hardcoded: a hardcoded dev IP once made every prod
          # apply point this job at the wrong subnet. See control_db_psc.tf.
          value = local.runtime_db_host
        }
        env {
          name  = "DB_USER"
          value = "tenant_app"
        }
        env {
          name  = "DB_NAME"
          value = "tenant_runtime"
        }
        env {
          name  = "QUERY"
          value = "" # Always overridden via --update-env-vars at execute time
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = "tenant-db-password"
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      # Image is :latest and gets resolved to a digest at job creation.
      # We don't want every terraform apply to fight that resolution.
      template[0].template[0].containers[0].image,
    ]
  }
}

# The psql break-glass job runs as the default Compute SA.
# Grant it secretAccessor on the tenant DB password it needs to connect.
resource "google_secret_manager_secret_iam_member" "compute_sa_tenant_db_password" {
  secret_id = "tenant-db-password"
  project   = google_project.tenant_runtime.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_project.tenant_runtime.number}-compute@developer.gserviceaccount.com"
}

# Cloud SQL client access for the Compute SA — required by the Cloud SQL Auth
# Proxy sidecar on tenant-runtime-migrate (which runs as the default Compute SA).
resource "google_project_iam_member" "compute_sa_cloudsql_client" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_project.tenant_runtime.number}-compute@developer.gserviceaccount.com"
}

# Allow tenant runtime (default compute SA) to manage Cloud Scheduler jobs.
# HISTORICAL: this binding was added when the Cloud Run service ran as the
# default compute SA. The service now runs as the proper tenant_runtime_sa
# (see iam module) which has its own cloudscheduler.admin binding. This
# binding is preserved for backwards compatibility — removing it would force
# a precise cutover order between Terraform apply and cloudbuild deploy. It
# is harmless to leave because the compute SA is no longer the active runtime
# identity.
resource "google_project_iam_member" "runtime_scheduler_admin" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/cloudscheduler.admin"
  member  = "serviceAccount:${google_project.tenant_runtime.number}-compute@developer.gserviceaccount.com"
}

# Allow tenant runtime to act as the scheduler SA (for OIDC tokens on
# Cloud Scheduler HTTP targets). Same historical note as above — kept for
# backwards compatibility.
resource "google_service_account_iam_member" "runtime_act_as_scheduler" {
  service_account_id = google_service_account.scheduler.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_project.tenant_runtime.number}-compute@developer.gserviceaccount.com"
}

# Allow the proper tenant_runtime_sa (the SA the Cloud Run service is now
# bound to via cloudbuild --service-account) to act as the scheduler SA.
# Without this, scheduler.createJob/updateJob calls fail with PERMISSION_DENIED
# on iam.serviceAccounts.actAs because the http_target.oidc_token.service_account_email
# refers to a service account the caller doesn't have actAs permission on.
resource "google_service_account_iam_member" "tenant_runtime_sa_act_as_scheduler" {
  service_account_id = google_service_account.scheduler.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${module.iam.tenant_runtime_sa}"
}

# sandbox-executor arms its own GC sweep when it claims a sandbox: a Cloud Task
# on the maintenance queue carrying the scheduler SA's OIDC token, the identity
# its gc-sweep route already accepts. Enqueue on that one queue, and actAs on
# that one SA.
resource "google_cloud_tasks_queue_iam_member" "sandbox_executor_maintenance_enqueuer" {
  project  = google_project.tenant_runtime.project_id
  location = var.region
  name     = "${var.tenant_id}-maintenance-tasks-${var.environment}-v2"
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.sandbox_executor.email}"

  depends_on = [module.cloud_tasks]
}

resource "google_service_account_iam_member" "sandbox_executor_act_as_scheduler" {
  service_account_id = google_service_account.scheduler.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

# Canonical reconciler (in agent-service) emits Layer A metrics via the
# Cloud Monitoring API into THIS tenant-runtime project. The reconciler runs
# as the tenant_runtime SA, which needs metricWriter to call
# monitoring.timeSeries.create. Existing platform_backend_metric_writer binds
# a DIFFERENT SA (platform-backend), so a separate binding is required here.
resource "google_project_iam_member" "tenant_runtime_metric_writer" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:tenant-${var.tenant_id}-runtime@tenant-${var.tenant_id}-${var.environment}.iam.gserviceaccount.com"
}

# Layer B (auditor) runs in YOUR_GCP_PROJECT${var.environment} and
# needs to list Cloud Scheduler jobs in every tenant-runtime project for the
# hourly count-based audit. Grant cross-project read access.
#
# Gated on var.audit_iam_enabled to avoid a chicken-and-egg failure on the
# very first deploy: the platform_control module creates the audit SA in
# the same `terraform apply` pass that this tenant module runs, and the
# cross-project IAM API rejects the principal until SA creation has
# propagated. The deterministic fix is a two-pass enable:
#   1. First apply (audit_iam_enabled=false, default): platform_control
#      creates the SA + the in-project bindings.
#   2. Operator flips audit_iam_enabled=true in env config + re-applies:
#      this binding lands cleanly because the SA already exists.
variable "audit_iam_enabled" {
  description = "True once the agent-scheduler-audit SA exists in the platform-control project. Gates the cross-project cloudscheduler.viewer binding to avoid a propagation-timing failure on green-field applies."
  type        = bool
  default     = false
}

resource "google_project_iam_member" "audit_sa_scheduler_viewer" {
  count   = var.audit_iam_enabled ? 1 : 0
  project = google_project.tenant_runtime.project_id
  role    = "roles/cloudscheduler.viewer"
  member  = "serviceAccount:agent-scheduler-audit@${local.platform_control_project_id}.iam.gserviceaccount.com"
}

# Add this tenant project to the central metric scope in
# YOUR_GCP_PROJECT${var.environment}, so the alert policies + the
# Layer D disagreement-emitter can read the Layer A metrics this project
# writes. Without this resource, listTimeSeries from the central project
# can only see central-project metrics.
#
# Uses the `google.platform_control` aliased provider — writes against the
# platform-control project's metric scope, not the tenant project. The default
# provider is bound to the tenant project and has no monitoring.metricsScopesAdmin
# on platform-control, so without this alias the apply fails with PERMISSION_DENIED.
resource "google_monitoring_monitored_project" "tenant_in_central_scope" {
  provider      = google.platform_control
  metrics_scope = "locations/global/metricsScopes/${local.platform_control_project_id}"
  name          = "locations/global/metricsScopes/${local.platform_control_project_id}/projects/${google_project.tenant_runtime.project_id}"
}

# -----------------------------------------------------------------------------
# Operational acceptance alerts for connector credential bug class fixes
#
# Context: the runtime previously cached connector OAuth credentials in an
# in-process secret value cache (5 min TTL). That cache produced a class of
# stale-token bugs and was deleted in
# Liftoff-Tenant-Runtime/src/infrastructure/secrets.ts. Every connector
# credential read now hits Secret Manager directly, and every getCredentials
# call hits Cloud SQL for the connector_credentials row. The implementation
# plan acceptance criteria says we need to know if removing the cache shifts
# enough load to require reintroducing a SHORT-LIVED keyed cache.
#
# These alerts give us automated visibility on the three thresholds the plan
# specifies. If any fires, the next change is to add a 30-second in-process
# cache keyed on connector_id (with explicit invalidation on refresh/revoke
# — NOT a long-lived value cache like the one we just deleted).
# -----------------------------------------------------------------------------

# Alert: Secret Manager request rate is suspiciously high.
#
# Threshold rationale: a healthy tenant project does ~1 secret access per
# tool call to fetch a connector credential. With 1 cron-fired agent doing
# 1 tool call per minute that's <0.02 req/s. With 100 such agents it's <2 req/s.
# 5 req/s sustained over 5 minutes means something is wrong (a hot loop, a
# misconfigured retry, or an unexpected scaling event). The alert is intended
# as a "go look" trigger, not a hard SLO breach.
resource "google_monitoring_alert_policy" "secret_manager_request_rate_high" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.tenant_runtime.project_id
  display_name = "Tenant Runtime: Secret Manager request rate high (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "Secret Manager accessSecretVersion > 5 req/s for 5 minutes"

    condition_threshold {
      filter = <<-EOT
        resource.type = "consumed_api"
        AND resource.labels.service = "secretmanager.googleapis.com"
        AND metric.type = "serviceruntime.googleapis.com/api/request_count"
      EOT

      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.slack[0].name]

  documentation {
    content   = <<-EOT
      ## Secret Manager Request Rate High

      The tenant runtime is calling Secret Manager more than 5 req/s sustained
      over 5 minutes. This is the operational check on connector
      credential caching — expect ~1 call per tool
      invocation, so anything above this threshold indicates either:

        - A hot loop somewhere in the runtime (e.g., the agent execution
          loop circuit breaker is not catching a permanent failure)
        - An unexpected agent scaling event (many tenants firing at once)
        - Genuine load growth that warrants reintroducing a short-lived
          credential cache

      **Action Required:**
      1. Check tenant runtime logs for repeated `Secret loaded from Secret Manager`
         entries within a tight time window — that indicates a loop.
      2. Check active agent count vs. baseline.
      3. If the load is genuine and sustained, add a SHORT-LIVED in-process
         cache keyed on connectorId in Liftoff-Tenant-Runtime
         src/connectors/credential-service.ts:
           - TTL strictly less than the access-token lifetime (30s is safe
             for every provider — Google: 1h, HubSpot: 30m, Slack: variable)
           - Explicit invalidation on refresh AND revoke
           - Do NOT reintroduce the long-lived value cache that was deleted.
    EOT
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "604800s" # 7 days
  }
}

# Alert: Cloud SQL connector_credentials query rate is suspiciously high.
#
# Threshold rationale: every getCredentials() call now does a SELECT against
# the connector_credentials table to read the row. Same load profile as the
# Secret Manager alert above. 5 req/s sustained for 5 minutes indicates
# either a hot loop or genuine load that warrants the short-lived cache.
resource "google_monitoring_alert_policy" "cloudsql_credential_query_rate_high" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.tenant_runtime.project_id
  display_name = "Tenant Runtime: Cloud SQL transactions high (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "Cloud SQL transactions/sec > 50 sustained for 5 minutes"

    # Cloud SQL doesn't expose per-table query metrics out of the box, so
    # we use the database-level transaction count as a proxy. The threshold
    # is set above the typical baseline of 5-10 tx/s for the existing
    # workload (event subscriber + scheduled execution + tool gateway) so
    # we don't false-positive on normal operation.
    condition_threshold {
      filter = <<-EOT
        resource.type = "cloudsql_database"
        AND resource.labels.database_id = "${google_project.tenant_runtime.project_id}:tenant-${var.tenant_id}-pg-${var.environment}"
        AND metric.type = "cloudsql.googleapis.com/database/postgresql/transaction_count"
      EOT

      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 50

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.slack[0].name]

  documentation {
    content   = <<-EOT
      ## Cloud SQL Transaction Rate High

      The tenant runtime database is doing > 50 transactions/sec sustained
      over 5 minutes. After the connector credential cache was deleted in
      Commit 1 of the connector-credential-bug-class-elimination plan,
      every connector tool call hits Cloud SQL for the credential record.
      A high transaction rate could indicate the new per-call cost is
      stacking up.

      **Action Required:**
      1. Run `SELECT pid, query, state FROM pg_stat_activity WHERE state = 'active';`
         in psql to see what's hot. If `connector_credentials` is dominant,
         that's the credential cache deletion biting.
      2. Check tenant runtime pool stats via /metrics endpoint:
         every pool should show idle > 0. If any pool's `waiting` count
         is climbing, contention is real.
      3. If credential reads are the dominant workload, add the SHORT-LIVED
         in-process cache (see the Secret Manager alert documentation for
         the cache requirements — TTL < access-token lifetime, explicit
         invalidation on refresh/revoke).
    EOT
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "604800s" # 7 days
  }
}

# Alert: Cloud Run tool-call latency p95 is high.
#
# Threshold rationale: a healthy connector tool call (Google Sheets append,
# HubSpot create, etc.) is 200-500ms p95. The plan acceptance criterion is
# "<500ms increase per call" post-deploy. Setting the alert at 2s gives
# headroom for noisy distributions while still catching a real regression.
resource "google_monitoring_alert_policy" "cloudrun_request_latency_high" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.tenant_runtime.project_id
  display_name = "Tenant Runtime: Cloud Run p95 latency high (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "agent-service p95 latency > 2s for 10 minutes"

    condition_threshold {
      filter = <<-EOT
        resource.type = "cloud_run_revision"
        AND resource.labels.service_name = "agent-service"
        AND metric.type = "run.googleapis.com/request_latencies"
      EOT

      duration        = "600s"
      comparison      = "COMPARISON_GT"
      threshold_value = 2000

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MEAN"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.slack[0].name]

  documentation {
    content   = <<-EOT
      ## Tenant Runtime p95 Latency High

      Cloud Run request latency p95 for the tenant-runtime service has
      exceeded 2 seconds for 10 minutes. After the connector credential
      cache was deleted, every tool call adds one Secret Manager round-trip
      (~50-150ms) plus one Cloud SQL SELECT (~5-15ms) per credential read.
      A latency spike beyond the expected ~150ms additional cost suggests
      a hidden N+1 or contention point.

      **Action Required:**
      1. Check the structured `Tool call executed` log entries for the
         duration field. If the duration jumped post-deploy, the regression
         is in the connector call path.
      2. Check Secret Manager API latency in the tenant project — if it's
         high too, the regression is upstream of the runtime.
      3. Check Cloud SQL pool contention — `waiting > 0` on any pool
         indicates the runtime is queueing on connections.
      4. If credential reads are the bottleneck, add the SHORT-LIVED
         in-process cache (see the Secret Manager alert documentation).
    EOT
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "604800s" # 7 days
  }
}

output "project_id" {
  value = google_project.tenant_runtime.project_id
}

output "project_number" {
  value       = google_project.tenant_runtime.number
  description = "Project number; Cloud Run's deterministic URLs (<service>-<number>.<region>.run.app) are built from it."
}

output "cloud_sql_connection_name" {
  value = var.control_pg_psc_enabled ? null : module.cloud_sql[0].connection_name
}

output "vpc_network_id" {
  value = google_compute_network.tenant_vpc.id
}

output "vpc_network_name" {
  value = google_compute_network.tenant_vpc.name
}


output "subnet_id" {
  value = google_compute_subnetwork.tenant_subnet.id
}

# -----------------------------------------------------------------------------
# Scheduler Job Outputs
# -----------------------------------------------------------------------------

output "scheduler_service_account" {
  description = "Scheduler service account email"
  value       = google_service_account.scheduler.email
}

