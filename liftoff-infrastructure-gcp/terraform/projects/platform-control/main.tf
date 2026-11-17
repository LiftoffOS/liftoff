# Platform Control Project
# Owns: control-plane Cloud SQL, Cloud Run services, IAM, Secret Manager, KMS
# Per Section 2: GCP Layout

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.11"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

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

variable "manage_org_iam" {
  description = "Whether to manage org-level IAM (requires org admin permissions)"
  type        = bool
  default     = false
}

variable "slack_bot_token" {
  description = "Slack Bot OAuth Token for alert notifications"
  type        = string
  default     = ""
  sensitive   = true
}

variable "shared_runtime_project_id" {
  description = <<-EOT
    GCP project hosting the SHARED runtime pool, i.e. the project whose service
    accounts are allowed to act for tenants on `hosting_mode='shared'`.

    Empty means "derive it": `YOUR_TENANT_PROJECT<env>`, which is where the shared
    pool actually lives today. The pool is a first-class tier that happens to sit
    in a project named for one tenant; set this explicitly if it ever moves.
  EOT
  type        = string
  default     = ""
}

variable "tenant_runtime_url" {
  description = "Tenant Runtime Cloud Run service URL for cross-service API calls"
  type        = string
}

variable "x402_wallet_address" {
  description = <<-EOT
    The platform x402 wallet's address on Base: the wallet connector-service
    signs from, whichever custodian holds it (X402_WALLET_PROVIDER there:
    the Coinbase CDP server wallet 'x402-wallet', or the Circle
    developer-controlled wallet in wallet set 'x402-<env>'). The two
    custodians hold different addresses, so this value moves with that
    setting; platform-backend's hourly low-balance check reads the live
    signer's address back and logs x402_wallet_address_mismatch when they
    disagree. Consumed by the treasury checks (x402-low-balance,
    x402-reconcile); empty means the wallet is not live and both checks
    report themselves skipped rather than failed. A PUBLIC address, not a
    secret — the credentials that can spend from it live in Secret Manager
    (x402-cdp_* / x402-circle_*).
  EOT
  type        = string
  default     = ""
}

variable "x402_low_balance_threshold_usd" {
  description = <<-EOT
    The USDC balance under which platform-backend's hourly x402 low-balance
    check pages (X402_LOW_BALANCE_THRESHOLD_USD). Empty leaves the service's
    own default ($10), which is prod's. Dev runs on pocket change by design,
    so it carries a figure in cents rather than paging every hour about a
    wallet nobody means to fill.
  EOT
  type        = string
  default     = ""
}

variable "apify_prepaid_token_usd" {
  description = <<-EOT
    The size of the Apify prepaid token platform-backend buys from the x402
    wallet (APIFY_PREPAID_TOKEN_USD). Empty leaves the service's own default
    ($10). Apify's minimum is $1, and the first token an environment ever buys
    is always that; this sets the size of every token after it. Kept at the
    minimum until real usage says otherwise: a token is non-refundable and
    expires in fourteen days.
  EOT
  type        = string
  default     = ""
}

variable "connector_service_enabled" {
  description = <<-EOT
    Whether to create the Connector Service Cloud Run + Cloud SQL
    resources. The module's IAM + SA plumbing is always created; this
    controls the live compute resources. Flip to true once the Connector Service
    image has been pushed to Artifact Registry.
  EOT
  type        = bool
  default     = false
}

variable "connector_service_min_instances" {
  description = "min-instances for the Connector Service (>= 1 eliminates cold starts)."
  type        = number
  default     = 1
}

variable "connector_service_security_enabled" {
  description = <<-EOT
    Whether to provision the VPC Service Controls perimeter around the
    Connector Service (module.connector_service_security). Defaults to
    null so the module's own environment-aware default applies — which
    enables VPC-SC for prod only. Dev/staging stay off until org-level
    Access Context Manager policies are in place.
  EOT
  type        = bool
  default     = null
}

variable "connector_service_security_extra_vpc_services" {
  description = <<-EOT
    Extra Google API services in-VPC workloads may call, beyond the perimeter's
    restricted_services. Prod sets ["storage.googleapis.com"] for the
    agent-diagnostics GCS scorecard sink; dev/staging leave it empty.
  EOT
  type        = list(string)
  default     = []
}

variable "connector_service_security_org_id" {
  description = <<-EOT
    Numeric GCP organization ID (e.g. \"123456789012\") that owns the
    Access Context Manager policy for the Connector Service VPC-SC
    perimeter. Required only when connector_service_security_enabled
    resolves to true; otherwise unused.
  EOT
  type        = string
  default     = ""
}

variable "connector_service_security_access_policy_name" {
  description = <<-EOT
    Access Context Manager policy name that hosts the Connector Service
    service perimeter. Must be the policy's numeric ID, not its full
    resource name. Required only when the security module is enabled.
  EOT
  type        = string
  default     = ""
}

variable "connector_service_security_admin_members" {
  description = <<-EOT
    IAM members (user:foo@bar.com, group:..., serviceAccount:...) that
    keep admin access to the connector-service Cloud Run service from
    outside the VPC-SC perimeter. Attached to the same access level as
    the connector-service SA. Empty list = SA-only access (perimeter
    locks out human operators).
  EOT
  type        = list(string)
  default     = []
}

variable "connector_service_security_allowed_caller_projects" {
  description = <<-EOT
    GCP project numbers (as strings) allowed to call the Connector
    Service through the VPC-SC perimeter. Typically the set of tenant-
    runtime project numbers for dedicated tenants.
  EOT
  type        = list(string)
  default     = []
}

variable "connector_service_max_instances" {
  description = "max-instances for the Connector Service autoscaler."
  type        = number
  default     = 10
}

variable "allowed_governance_subscribers" {
  description = <<-EOT
    Service account emails that receive roles/pubsub.subscriber on
    governance-events-{env}-tenant-runtime-sub. Typically the tenant
    runtime SAs of every dedicated tenant that needs kill-switch /
    correction / reflection events from governance-engine.
  EOT
  type        = list(string)
  default     = []
}

# -----------------------------------------------------------------------------
# Governance Engine variables (Phase 3)
# -----------------------------------------------------------------------------

variable "governance_engine_enabled" {
  description = <<-EOT
    Whether to create the Governance Engine Cloud Run + platform-backend
    invoker IAM binding. The module's SA, Cloud SQL instance, and
    Secret Manager plumbing are always created; this flag controls the
    live compute + IAM-on-the-service. Flip to true once the
    governance-engine image has been pushed to Artifact Registry by the
    Cloud Build trigger.

    Default null → module's own default (currently false) applies.
  EOT
  type        = bool
  default     = null
}

variable "governance_engine_min_instances" {
  description = "min-instances for the Governance Engine (>= 1 eliminates cold starts on the authorize path)."
  type        = number
  default     = 1
}

variable "governance_engine_max_instances" {
  description = "max-instances for the Governance Engine autoscaler."
  type        = number
  default     = 10
}

variable "harvest_service_enabled" {
  description = <<-EOT
    Whether to create the Harvest Service Cloud Run resource. The SA, secrets,
    and Pub/Sub subscription are always created; this controls the live compute.
    Flip to true once the liftoff-harvest-service image has been pushed.
  EOT
  type        = bool
  default     = false
}

variable "harvest_service_min_instances" {
  description = "min-instances for the Harvest Service (>= 1 eliminates cold starts)."
  type        = number
  default     = 1
}

variable "harvest_service_max_instances" {
  description = "max-instances for the Harvest Service autoscaler."
  type        = number
  default     = 10
}

variable "tunnel_service_enabled" {
  description = <<-EOT
    Whether to provision the live tunnel-service Cloud Run + GCLB stack
    (cert, IP, NEG, backend, URL map, proxy, forwarding rule, Cloudflare DNS).
    The service account, service-auth secret, Pub/Sub topic, and Cloud Scheduler
    jobs are always created; this controls the data-plane resources.
    Flip to true once the liftoff-tunnel-service image has been pushed.
  EOT
  type        = bool
  default     = false
}

variable "tunnel_base_domain" {
  description = <<-EOT
    Per-env FQDN that fronts the tunnel terminator. Customer chisel clients
    connect to wss://<this>/_tunnel/ws and agent traffic flows in via
    <prefix>-<subdomain>.<this>. Distinct between envs so dev and prod don't
    collide in Cloudflare (both zones share example.com).
    Defaults to the prod value; dev wrapper overrides to tunnels-dev.example.com.
    Must be a subdomain of example.com.
  EOT
  type        = string
  default     = "tunnels.example.com"
}

# A job every few minutes keeps the service it calls awake for good: Cloud Run
# keeps an instance about fifteen minutes after its last request, so anything
# more frequent never lets it go, and every call that service makes onward wakes
# the next one. At :00 these share one wake an hour with the tenant runtime's
# own idle-cadence jobs. The cost is latency on the sweeps and reconcilers
# (noticed within the hour, not within minutes). Set false once there is traffic.
variable "idle_cadence" {
  description = "Run every sub-hourly scheduler job hourly at :00 so idle services can scale to zero."
  type        = bool
  default     = false
}

locals {
  idle_schedule = "0 * * * *"
}

variable "tunnel_service_min_instances" {
  description = "min-instances for tunnel-service. 0 until customers run tunnels: the first connect after idle takes a cold start, which a chisel client retries through."
  type        = number
  default     = 0
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token (Zone:DNS:Edit on example.com). Used for tunnel-service DNS A records. Sourced from Secret Manager via the environment wrapper."
  type        = string
  sensitive   = true
  default     = ""
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for example.com. Required when tunnel_service_enabled = true."
  type        = string
  default     = ""
}

variable "platform_backend_image_sha" {
  description = "Image SHA for the data-export-orchestrator Cloud Run job. Set to a real SHA to deploy the job; leave as 'placeholder' to skip job creation until the image is built."
  type        = string
  default     = "placeholder"
}

variable "mcp_oauth_enabled" {
  description = "Release gate: advertise the MCP OAuth front door (.well-known + WWW-Authenticate challenge). Flip per environment."
  type        = string
  default     = "false"
}

variable "platform_callback_token" {
  description = "PLATFORM_CALLBACK_TOKEN for authenticating internal maintenance service calls"
  type        = string
  sensitive   = true
  default     = ""
}

locals {
  project_id = "YOUR_GCP_PROJECT${var.environment}"
}

# -----------------------------------------------------------------------------
# Project
# -----------------------------------------------------------------------------

resource "google_project" "platform_control" {
  name            = "Platform Control ${var.environment}"
  project_id      = local.project_id
  org_id          = var.org_id
  billing_account = var.billing_account
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
    "cloudtrace.googleapis.com",
    "logging.googleapis.com",
    "aiplatform.googleapis.com",
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "vpcaccess.googleapis.com",
    "cloudscheduler.googleapis.com",
    "bigquery.googleapis.com",
    "containeranalysis.googleapis.com",
    "storage.googleapis.com",
    "binaryauthorization.googleapis.com",
    "dataflow.googleapis.com",
    # Required for platform-backend's allowed_domains Remote Config lookup.
    # ADC's quota project for cross-project API calls is this host project,
    # so the API must be enabled here (the resource lives in YOUR_WEB_PROJECT).
    "firebaseremoteconfig.googleapis.com",
    # Required for platform-backend's browser push sends. Same cross-project
    # shape as Remote Config directly above: ADC's quota project for the call is
    # this host project, so the API must be enabled here even though the FCM
    # resource being written lives in YOUR_WEB_PROJECT.
    "fcm.googleapis.com",
    # Certificate Manager for the tunnel-service wildcard cert on
    # *.tunnels.example.com (legacy classic SSL cert doesn't support wildcards).
    "certificatemanager.googleapis.com",
    # Speech-to-Text backs voice dictation in agent chat. platform-backend holds
    # a streaming recognition session open against the inline `_` recognizer in
    # this project, so the API has to be enabled here rather than wherever the
    # audio came from.
    "speech.googleapis.com",
    # Text-to-Speech gives the agents a voice. Unlike Speech-to-Text there is no
    # role to grant: no predefined role carries any texttospeech.* permission,
    # so enabling the API here is the whole access story.
    "texttospeech.googleapis.com",
  ])

  project                    = google_project.platform_control.project_id
  service                    = each.value
  disable_dependent_services = false
}

# -----------------------------------------------------------------------------
# VPC Network (required for Cloud SQL private IP)
# -----------------------------------------------------------------------------

resource "google_compute_network" "main" {
  project                 = google_project.platform_control.project_id
  name                    = "vpc-${var.environment}"
  auto_create_subnetworks = false

  depends_on = [google_project_service.apis]
}

resource "google_compute_subnetwork" "main" {
  project       = google_project.platform_control.project_id
  name          = "subnet-${var.region}-${var.environment}"
  ip_cidr_range = "10.0.0.0/20"
  region        = var.region
  network       = google_compute_network.main.id

  private_ip_google_access = true
}

# Private Service Connection for Cloud SQL
resource "google_compute_global_address" "private_ip_range" {
  project       = google_project.platform_control.project_id
  name          = "private-ip-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_range.name]

  depends_on = [google_project_service.apis]
}

# Serverless VPC Access Connector for Cloud Run
# No Serverless VPC Access connector: every Cloud Run service and job here uses
# Direct VPC egress on google_compute_subnetwork.main. A connector runs two
# e2-micro VMs around the clock for traffic the subnet carries directly.

# No Cloud NAT. Every workload here egresses PRIVATE_RANGES_ONLY, so its
# internet traffic leaves directly and the VPC carries only 10.x. A NAT existed
# for the agent-diagnostics job alone, which sent ALL traffic through the VPC to
# reach an internal-only evaluator; it cost ~$9/month for one daily run. An
# ALL_TRAFFIC workload added here has no internet path until a NAT returns.

# -----------------------------------------------------------------------------
# Service Accounts
# Per Section 20: Least-privilege IAM
# -----------------------------------------------------------------------------

# Platform Backend Service Account
resource "google_service_account" "platform_backend" {
  project      = google_project.platform_control.project_id
  account_id   = "platform-backend-${var.environment}"
  display_name = "Platform Backend Service Account"

  depends_on = [google_project_service.apis]
}

# Pub/Sub Publisher Service Account
resource "google_service_account" "pubsub_publisher" {
  project      = google_project.platform_control.project_id
  account_id   = "pubsub-publisher-${var.environment}"
  display_name = "Pub/Sub Publisher Service Account"

  depends_on = [google_project_service.apis]
}

# Cloud Tasks Service Account
resource "google_service_account" "cloud_tasks" {
  project      = google_project.platform_control.project_id
  account_id   = "cloud-tasks-${var.environment}"
  display_name = "Cloud Tasks Service Account"

  depends_on = [google_project_service.apis]
}

# Tenant Provisioner Service Account
resource "google_service_account" "tenant_provisioner" {
  project      = google_project.platform_control.project_id
  account_id   = "tenant-provisioner-${var.environment}"
  display_name = "Tenant Provisioner Service Account"

  depends_on = [google_project_service.apis]
}

# Cloud Build Service Account for CI/CD
resource "google_service_account" "cloud_build" {
  project      = google_project.platform_control.project_id
  account_id   = "cloud-build-${var.environment}"
  display_name = "Cloud Build Service Account"

  depends_on = [google_project_service.apis]
}

# -----------------------------------------------------------------------------
# IAM Role Bindings
# -----------------------------------------------------------------------------

# Platform Backend permissions
resource "google_project_iam_member" "platform_backend_sql" {
  project = google_project.platform_control.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

# roles/secretmanager.admin (not just secretAccessor) because platform-backend
# creates secrets at runtime: custom-mcp-server-* credential blobs for the
# custom MCP server connector, OAuth credential blobs for tenant connections,
# etc. tenant_provisioner already has this role for the same reason.
resource "google_project_iam_member" "platform_backend_secrets" {
  project = google_project.platform_control.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_project_iam_member" "platform_backend_pubsub" {
  project = google_project.platform_control.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_project_iam_member" "platform_backend_trace" {
  project = google_project.platform_control.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_project_iam_member" "platform_backend_logging" {
  project = google_project.platform_control.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_project_iam_member" "platform_backend_tasks" {
  project = google_project.platform_control.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_project_iam_member" "connector_service_tasks_enqueuer" {
  project = google_project.platform_control.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${module.connector_service.service_account_email}"
}

# Connector-service Cloud Tasks jobs POST back to the connector-service Cloud Run
# execute endpoint using OIDC authentication. The SA must be a run.invoker on its
# own service for Cloud Tasks to generate a valid OIDC token for the request.
resource "google_cloud_run_v2_service_iam_member" "connector_service_self_invoker" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = module.connector_service.service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.connector_service.service_account_email}"
}

# Cloud Tasks createTask() requires the calling SA to have iam.serviceAccounts.actAs
# on whichever SA is specified as the OIDC identity. Since connector-service uses
# itself as the OIDC identity for execute-endpoint tasks, it needs SA User on itself.
resource "google_service_account_iam_member" "connector_service_self_act_as" {
  service_account_id = module.connector_service.service_account_name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${module.connector_service.service_account_email}"
}

# Cloud Tasks service agent must be able to generate OIDC tokens for the
# connector-service SA when dispatching tasks to the Cloud Run execute endpoint.
# The Cloud Tasks service agent email format is service-{project_number}@gcp-sa-cloudtasks.iam.gserviceaccount.com
resource "google_service_account_iam_member" "cloud_tasks_connector_service_token_creator" {
  service_account_id = module.connector_service.service_account_name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
}

# Vertex AI permission for Claude Opus - Section 17
resource "google_project_iam_member" "platform_backend_vertex_ai" {
  project = google_project.platform_control.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Speech-to-Text for voice dictation. Without this the transcribe endpoint
# answers 500 on its very first call with PERMISSION_DENIED on
# speech.recognizers.recognize — and that is easy to miss in development, because
# a developer's own credentials can call the API long before the Cloud Run
# runtime identity can. roles/speech.client is the least-privilege fit: it
# carries recognizers.recognize plus read-only access to recognizers, phrase
# sets and operations, and no write permissions at all.
resource "google_project_iam_member" "platform_backend_speech_client" {
  project = google_project.platform_control.project_id
  role    = "roles/speech.client"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Tenant Provisioner permissions (needs to create projects and resources)
# These require org admin permissions - only run when manage_org_iam is true
resource "google_organization_iam_member" "tenant_provisioner_project_creator" {
  count  = var.manage_org_iam ? 1 : 0
  org_id = var.org_id
  role   = "roles/resourcemanager.projectCreator"
  member = "serviceAccount:${google_service_account.tenant_provisioner.email}"
}

resource "google_organization_iam_member" "tenant_provisioner_billing" {
  count  = var.manage_org_iam ? 1 : 0
  org_id = var.org_id
  role   = "roles/billing.user"
  member = "serviceAccount:${google_service_account.tenant_provisioner.email}"
}

resource "google_project_iam_member" "tenant_provisioner_sql" {
  project = google_project.platform_control.project_id
  role    = "roles/cloudsql.admin"
  member  = "serviceAccount:${google_service_account.tenant_provisioner.email}"
}

resource "google_project_iam_member" "tenant_provisioner_secrets" {
  project = google_project.platform_control.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${google_service_account.tenant_provisioner.email}"
}

# Cloud Build permissions
resource "google_project_iam_member" "cloud_build_run" {
  project = google_project.platform_control.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

resource "google_project_iam_member" "cloud_build_sa_user" {
  project = google_project.platform_control.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

resource "google_project_iam_member" "cloud_build_artifact_registry" {
  project = google_project.platform_control.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

resource "google_project_iam_member" "cloud_build_logs" {
  project = google_project.platform_control.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud Tasks invoker permissions
resource "google_project_iam_member" "cloud_tasks_invoker" {
  project = google_project.platform_control.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.cloud_tasks.email}"
}

# -----------------------------------------------------------------------------
# Cloud SQL for PostgreSQL - Control Plane Database
# Per Section 5: Connection budgeting and managed connection pooling
# -----------------------------------------------------------------------------

variable "control_plane_psc_consumer_projects" {
  description = "Projects allowed to reach control-plane-pg through a Private Service Connect endpoint of their own. Empty: PSC off."
  type        = list(string)
  default     = []
}

output "control_plane_psc_service_attachment" {
  description = "Service attachment a consumer project's PSC endpoint targets, or null while PSC is off."
  value       = google_sql_database_instance.control_plane.psc_service_attachment_link
}

resource "google_sql_database_instance" "control_plane" {
  project          = google_project.platform_control.project_id
  name             = "control-plane-pg-${var.environment}"
  database_version = "POSTGRES_15"
  region           = var.region

  # Per Section 20: CMEK encryption for Cloud SQL
  # Note: Only applied to new instances, cannot be added to existing instances
  encryption_key_name = var.environment == "prod" ? google_kms_crypto_key.database.id : null

  # Shared-core, no standby, until there is real load: a 4 vCPU REGIONAL
  # instance is expensive to keep idle. db-g1-small carries no SLA.
  # Raise the tier and flip REGIONAL back together when it needs to carry traffic.
  settings {
    tier              = "db-g1-small"
    availability_type = "ZONAL"
    # A disk can only be shrunk out of band (`gcloud sql instances
    # perform-storage-shrink`; Terraform cannot shrink, and the API refuses it
    # on shared-core tiers, so the instance has to move to a dedicated-core
    # tier such as db-custom-1-3840 for the operation and back). The floor is
    # about data in use + 50 GB. Keep this at the live size: a larger value
    # grows the disk, and only another shrink undoes that.
    disk_size       = var.environment == "prod" ? 54 : 20
    disk_autoresize = true

    # Sized for this database plus the connector and governance databases that
    # share the instance; peaks are deploy overlaps. 1.7 GB of RAM holds ~100
    # backends.
    database_flags {
      name  = "max_connections"
      value = "100"
    }

    # Phase 0g — pgaudit streams DDL + ROLE commands to Cloud Logging
    # for out-of-band review. `all` logs too much; `ddl,role` is the
    # plan's exact scope. Preload plus the log flag together are what
    # Cloud SQL requires.
    database_flags {
      name  = "cloudsql.enable_pgaudit"
      value = "on"
    }
    database_flags {
      name  = "pgaudit.log"
      value = "ddl,role"
    }
    database_flags {
      name  = "pgaudit.log_catalog"
      value = "off"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = var.environment == "prod"
      start_time                     = "03:00"
      location                       = var.region
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id

      # Private Service Connect beside the private IP: a project on another
      # network reaches the instance through an endpoint of its own, with no
      # network peering and nothing crossing the control VPC's service
      # perimeter (the tenant runtime keeps its `tenant_runtime` database
      # here; see tenant-runtime-template/control_db_psc.tf).
      dynamic "psc_config" {
        for_each = length(var.control_plane_psc_consumer_projects) > 0 ? [1] : []
        content {
          psc_enabled               = true
          allowed_consumer_projects = var.control_plane_psc_consumer_projects
        }
      }
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
      # Cloud SQL refuses client-address recording on an instance with PSC
      # connectivity ("not supported for instances with PSC connectivity").
      record_client_address = length(var.control_plane_psc_consumer_projects) == 0
    }

    maintenance_window {
      day          = 7 # Sunday
      hour         = 4
      update_track = "stable"
    }
  }

  deletion_protection = var.environment == "prod"

  # scripts/dev-power.sh stops and starts the dev instances; an apply must not
  # restart a sleeping one.
  lifecycle {
    ignore_changes = [settings[0].activation_policy]
  }

  depends_on = [
    google_service_networking_connection.private_vpc_connection,
    google_kms_crypto_key_iam_member.cloudsql_database_key
  ]
}

# Control plane database
resource "google_sql_database" "control_plane" {
  project  = google_project.platform_control.project_id
  instance = google_sql_database_instance.control_plane.name
  name     = "liftoff_control"
}

# Database user
resource "google_sql_user" "control_plane" {
  project  = google_project.platform_control.project_id
  instance = google_sql_database_instance.control_plane.name
  name     = "liftoff_app"
  password = random_password.db_password.result
}

resource "random_password" "db_password" {
  length  = 32
  special = false # Avoid special chars for easier connection string handling
}

# Store DB password in Secret Manager with CMEK
resource "google_secret_manager_secret" "db_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "control-plane-db-password"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db_password.result
}

# Store DB connection string in Secret Manager with CMEK
resource "google_secret_manager_secret" "db_connection" {
  labels    = { type = "db-connection", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "control-plane-db-connection"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "db_connection" {
  secret      = google_secret_manager_secret.db_connection.id
  secret_data = "postgresql://liftoff_app:${random_password.db_password.result}@${google_sql_database_instance.control_plane.private_ip_address}:5432/liftoff_control"
}

# -----------------------------------------------------------------------------
# Connector Service secrets (Phase 1 — extraction)
# Created unconditionally so the module.connector_service can reference them
# whether or not var.connector_service_enabled is true. The Cloud Run service
# only binds to them when enabled = true.
# -----------------------------------------------------------------------------

resource "random_password" "connector_db_password" {
  length  = 32
  special = false
}

resource "random_password" "connector_service_token" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "connector_pg_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "connector-pg-password"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "connector_pg_password" {
  secret      = google_secret_manager_secret.connector_pg_password.id
  secret_data = random_password.connector_db_password.result
}

resource "google_secret_manager_secret" "connector_service_token" {
  labels    = { type = "service-auth", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "connector-service-token"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "connector_service_token" {
  secret      = google_secret_manager_secret.connector_service_token.id
  secret_data = random_password.connector_service_token.result
}

# -----------------------------------------------------------------------------
# Agent Slack service token (per-agent Slack tool + HITL review fan-out)
#
# Shared bearer token authenticating platform-backend ↔ tenant-runtime
# internal HTTP calls on /api/internal/agent-slack/* (installs lookup,
# postReviewDm/postDraftDm fan-out, assignees query). Same pattern as
# connector-service-token: created centrally here, copied into each
# per-tenant project at tenant-runtime deploy time via cloudbuild.yaml.
#
# NOT a Slack-issued token. The existing Slack OAuth client credentials,
# manifest config token, per-app signing secrets, and per-install bot
# tokens are all separate and untouched.
# -----------------------------------------------------------------------------

resource "random_password" "agent_slack_service_token" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "agent_slack_service_token" {
  labels    = { type = "service-auth", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "agent-slack-service-token"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "agent_slack_service_token" {
  secret      = google_secret_manager_secret.agent_slack_service_token.id
  secret_data = random_password.agent_slack_service_token.result
}

# -----------------------------------------------------------------------------
# Microsoft Teams secrets
# AGENT_TEAMS_SERVICE_TOKEN is Terraform-managed (mirrors agent_slack). The bot
# app id/password + Graph client secret originate in Azure — declare the
# containers here and add versions out-of-band after Azure provisioning (same
# pattern as the Anthropic/OAuth keys). Cloud Run references version "latest",
# so a version must exist before the next deploy that binds them.
# -----------------------------------------------------------------------------
resource "random_password" "agent_teams_service_token" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "agent_teams_service_token" {
  labels    = { type = "service-auth", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "agent-teams-service-token"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "agent_teams_service_token" {
  secret      = google_secret_manager_secret.agent_teams_service_token.id
  secret_data = random_password.agent_teams_service_token.result
}

locals {
  teams_azure_secret_ids = {
    teams_bot_app_id          = "teams-bot-app-id"
    teams_bot_app_password    = "teams-bot-app-password"
    teams_graph_client_secret = "teams-graph-client-secret"
  }
}

resource "google_secret_manager_secret" "teams_azure" {
  for_each  = local.teams_azure_secret_ids
  labels    = { type = "teams-azure", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = each.value

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

# -----------------------------------------------------------------------------
# Governance Engine secrets (Phase 3)
# Created unconditionally so the module.governance_engine can reference them
# whether or not var.governance_engine_enabled is true. The Cloud Run service
# only binds to them when enabled = true.
# -----------------------------------------------------------------------------

resource "random_password" "governance_db_password" {
  length  = 32
  special = false
}

resource "random_password" "governance_engine_token" {
  length  = 48
  special = false
}

resource "random_password" "governance_preflight_signing_key" {
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "governance_pg_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "governance-pg-password"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "governance_pg_password" {
  secret      = google_secret_manager_secret.governance_pg_password.id
  secret_data = random_password.governance_db_password.result
}

resource "google_secret_manager_secret" "governance_engine_token" {
  labels    = { type = "service-auth", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "governance-engine-token"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "governance_engine_token" {
  secret      = google_secret_manager_secret.governance_engine_token.id
  secret_data = random_password.governance_engine_token.result
}

resource "google_secret_manager_secret" "governance_preflight_signing_key" {
  labels    = { type = "signing-key", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "governance-preflight-signing-key"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "governance_preflight_signing_key" {
  secret      = google_secret_manager_secret.governance_preflight_signing_key.id
  secret_data = random_password.governance_preflight_signing_key.result
}

# -----------------------------------------------------------------------------
# Harvest Service secrets
# Created unconditionally so the harvest_service module can reference them
# whether or not harvest_service_enabled is true.
# -----------------------------------------------------------------------------

resource "random_password" "harvest_db_password" {
  length  = 32
  special = false
}

resource "random_password" "harvest_service_token" {
  length  = 48
  special = false
}

resource "random_password" "harvest_tenant_runtime_service_token" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "harvest_pg_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "harvest-pg-password"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "harvest_pg_password" {
  secret      = google_secret_manager_secret.harvest_pg_password.id
  secret_data = random_password.harvest_db_password.result
}

resource "google_secret_manager_secret" "harvest_service_token" {
  labels    = { type = "service-auth", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "harvest-service-token"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "harvest_service_token" {
  secret      = google_secret_manager_secret.harvest_service_token.id
  secret_data = random_password.harvest_service_token.result
}

resource "google_secret_manager_secret" "harvest_tenant_runtime_service_token" {
  labels    = { type = "service-auth", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "harvest-tenant-runtime-service-token"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

# The token's live value is a version added by hand to match the runtime, not
# the one Terraform would create from the random_password below. Managing the
# version here would ADD the stale Terraform value as a new latest and break harvest ->
# tenant-runtime auth on harvest's next deploy, so state forgets it instead.
removed {
  from = google_secret_manager_secret_version.harvest_tenant_runtime_service_token
  lifecycle {
    destroy = false
  }
}

# Cloud SQL database + user for harvest service
resource "google_sql_database" "harvest" {
  project  = google_project.platform_control.project_id
  instance = google_sql_database_instance.control_plane.name
  name     = "harvest"
}

resource "google_sql_user" "harvest_app" {
  project  = google_project.platform_control.project_id
  instance = google_sql_database_instance.control_plane.name
  name     = "harvest_app"
  password = random_password.harvest_db_password.result

  depends_on = [google_sql_database.harvest]
}

# -----------------------------------------------------------------------------
# Billing controls secrets (Phase 0)
# BILLING_SERVICE_TOKEN: HMAC-SHA256 signing key for platform-backend internal
# billing API. liftoff-billing signs requests with this key; platform-backend
# verifies them (SE-007: internal service authentication).
# -----------------------------------------------------------------------------

resource "random_password" "billing_service_token" {
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "billing_service_token" {
  labels    = { type = "service-auth", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "billing-service-token"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

resource "google_secret_manager_secret_version" "billing_service_token" {
  secret      = google_secret_manager_secret.billing_service_token.id
  secret_data = random_password.billing_service_token.result

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# The value consumers must use: the secret's LATEST version, which survives
# out-of-band rotations that random_password state cannot see. Reads at plan
# time, so an apply after a rotation re-syncs every scheduler header.
data "google_secret_manager_secret_version" "billing_service_token_current" {
  secret = google_secret_manager_secret.billing_service_token.id

  depends_on = [google_secret_manager_secret_version.billing_service_token]
}

# -----------------------------------------------------------------------------
# Pub/Sub Topics for Control Plane Events
# Per Section 4: Control-plane → tenant-runtime contract
# -----------------------------------------------------------------------------

locals {
  control_plane_topics = [
    "control-plane-events",
    "tenant-entitlement-updated",
    "tenant-suspended",
    "tenant-reactivated",
    "tenant-deployment-approved",
    "tenant-model-config-updated",
    "tenant-prompt-bundle-updated",
    "tenant-feature-flag-updated",
    "tenant-provisioned",
    "tenant-migration-status",
  ]
}

resource "google_pubsub_topic" "control_plane" {
  for_each = toset(local.control_plane_topics)

  project = google_project.platform_control.project_id
  name    = "${each.value}-${var.environment}"

  message_retention_duration = "604800s" # 7 days

  depends_on = [google_project_service.apis]
}

# Dead letter topic for failed messages
resource "google_pubsub_topic" "dead_letter" {
  project = google_project.platform_control.project_id
  name    = "dead-letter-${var.environment}"

  message_retention_duration = "604800s"

  depends_on = [google_project_service.apis]
}

# tenant_runtime_config invalidation fan-out.
#
# When tenant runtime config changes in the control plane, platform-backend
# publishes here and every tenant project's coordinator pulls the invalidation
# (cross-project sub: tenant-runtime-template/tenant_runtime_config_invalidation.tf). Kept as
# a standalone topic (not in local.control_plane_topics) because its subscriber
# is a tenant-side cache invalidation pull, not the control-plane event push set.
resource "google_pubsub_topic" "tenant_runtime_config_updated" {
  project = google_project.platform_control.project_id
  name    = "tenant-runtime-config-updated-${var.environment}"

  message_retention_duration = "604800s" # 7 days

  depends_on = [google_project_service.apis]
}

# Pub/Sub Subscriptions for tenant-runtime consumption
# Per Section 4: Control-plane → tenant-runtime contract
resource "google_pubsub_subscription" "tenant_runtime" {
  for_each = toset(local.control_plane_topics)

  project = google_project.platform_control.project_id
  name    = "${each.value}-tenant-runtime-${var.environment}"
  topic   = google_pubsub_topic.control_plane[each.key].id

  # Subscription settings per Section 4 - versioned event handling
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s" # 7 days
  retain_acked_messages      = false
  expiration_policy {
    ttl = "" # Never expire
  }

  # Dead letter policy
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  depends_on = [google_project_service.apis]
}

# -----------------------------------------------------------------------------
# Trajectory storage bucket.
#
# Agent execution trajectories are written here by tenant-runtime (write-only:
# tenant-runtime SAs get roles/storage.objectCreator, NOT objectViewer/Admin —
# they push trajectories but never read or mutate existing objects). The
# cross-project objectCreator binding lives in the tenant-runtime-template (see
# trajectory_storage.tf there), granted to each tenant's module.iam.tenant_runtime_sa,
# because no single tenant-runtime SA identity exists in this control project.
#
# Shape mirrors browser-screenshots-bucket.tf in tenant-runtime-template:
# US-WEST1, uniform_bucket_level_access, single delete lifecycle rule (365d here).
resource "google_storage_bucket" "trajectories" {
  project                     = google_project.platform_control.project_id
  name                        = "trajectories-${var.environment}"
  location                    = "US-WEST1"
  uniform_bucket_level_access = true

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

# Dead letter subscription for monitoring failed messages
resource "google_pubsub_subscription" "dead_letter" {
  project = google_project.platform_control.project_id
  name    = "dead-letter-monitor-${var.environment}"
  topic   = google_pubsub_topic.dead_letter.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  depends_on = [google_project_service.apis]
}

# -----------------------------------------------------------------------------
# Governance Engine control-plane event subscriptions
#
# governance-engine subscribes to the shared control-plane-events topic to
# materialise two local cache tables:
#
#   governance-entitlements-{env}-sub  →  cached_entitlements
#     Handles: tenant.entitlement.updated
#     Handler: src/events/entitlements-subscriber.ts
#     Env var: ENTITLEMENTS_SUBSCRIPTION_NAME (defaults match resource name)
#
#   governance-oversight-{env}-sub     →  tenant_oversight_cache
#     Handles: tenant.oversight.updated
#     Handler: src/events/oversight-subscriber.ts
#     Env var: OVERSIGHT_SUBSCRIPTION_NAME (defaults match resource name)
#
#   governance-agent-lifecycle-{env}-sub  →  agents
#     Handles: tenant.internal_agent.created, .status_changed, .deleted
#     Handler: src/events/agent-lifecycle-subscriber.ts
#     Env var: AGENT_LIFECYCLE_SUBSCRIPTION_NAME (defaults match resource name)
#     Needed by checkAgentLifecycle in admission/service.ts; without this
#     table populated every Preflight call with an agentId returns HTTP 500.
#
# Each gets its own subscription so governance-engine has an independent
# delivery cursor and doesn't share ack state with tenant-runtime's
# control-plane-events-tenant-runtime-{env} subscription.
#
# No DLQ: the handlers nack on transient failures so Pub/Sub redelivers
# automatically. Persistent failures are logged and the cache row just
# stays stale until the next successful delivery.
# -----------------------------------------------------------------------------

locals {
  governance_engine_control_plane_subscriptions = {
    "governance-entitlements"    = "control-plane-events"
    "governance-oversight"       = "control-plane-events"
    "governance-agent-lifecycle" = "control-plane-events"
  }
}

resource "google_pubsub_subscription" "governance_engine_control_plane" {
  for_each = local.governance_engine_control_plane_subscriptions

  project = google_project.platform_control.project_id
  name    = "${each.key}-${var.environment}-sub"
  topic   = google_pubsub_topic.control_plane[each.value].id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s" # 7 days
  retain_acked_messages      = false

  expiration_policy {
    ttl = "" # never expire
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription_iam_member" "governance_engine_control_plane_subscriber" {
  for_each = local.governance_engine_control_plane_subscriptions

  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.governance_engine_control_plane[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${module.governance_engine.service_account_email}"
}

# -----------------------------------------------------------------------------
# Harvest Service Pub/Sub
# Topic: connector-events-{env} is a shared topic owned by this module.
# connector-service is granted pubsub.publisher on it. Subscription:
# harvest-service consumes to classify records into tenant-runtime memory.
# DLQ (dead-letter) configured with maxDeliveryAttempts=5 to prevent
# poison-pill messages from exhausting flow-control slots (INF-002).
# -----------------------------------------------------------------------------

resource "google_pubsub_topic" "connector_events" {
  project = google_project.platform_control.project_id
  name    = "connector-events-${var.environment}"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic_iam_member" "connector_events_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.connector_events.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${module.connector_service.service_account_email}"
}

resource "google_pubsub_topic_iam_member" "connector_service_control_plane_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.control_plane["control-plane-events"].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${module.connector_service.service_account_email}"
}

resource "google_pubsub_topic" "harvest_dlq" {
  project = google_project.platform_control.project_id
  name    = "connector-events-${var.environment}-harvest-dlq"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription" "harvest_connector_events" {
  project = google_project.platform_control.project_id
  name    = "connector-events-${var.environment}-harvest-sub"
  topic   = google_pubsub_topic.connector_events.id

  # Push handler may run an LLM classify; give it room up to harvest-service's
  # Cloud Run --timeout (300s) before Pub/Sub redelivers. Dedup makes an
  # occasional redelivery harmless.
  ack_deadline_seconds       = 300
  message_retention_duration = "604800s" # 7 days
  retain_acked_messages      = false

  expiration_policy {
    ttl = "" # never expire
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.harvest_dlq.id
    max_delivery_attempts = 5
  }

  # PUSH: wake harvest-service on each event, process, ack (204) / nack (5xx ->
  # redelivered per retry_policy), scale back to zero. OIDC verified by Cloud Run
  # ingress (service is --no-allow-unauthenticated).
  push_config {
    push_endpoint = "${data.google_cloud_run_v2_service.harvest.uri}/pubsub/connector-events"

    oidc_token {
      service_account_email = google_service_account.harvest_pubsub_push.email
      audience              = data.google_cloud_run_v2_service.harvest.uri
    }
  }

  depends_on = [google_project_service.apis]
}

# -----------------------------------------------------------------------------
# Governance Engine Pub/Sub — multiplexed events stream
# Plan §3e / GCP Layout: single `governance-events-${env}` topic carries
# every governance event. Message EVENT TYPE (e.g.
# `governance.kill_switch_changed`) lives on the Pub/Sub message attribute
# `eventType`; subscribers filter on that.
#
# Subscribers include tenant-runtime instances, which use the
# kill_switch_changed event to evict cached preflights in <5s.
# The governance-engine SA is granted publish rights project-wide (see
# governance_engine_pubsub_publisher in the module); tenant-runtime
# subscriptions to this topic are created per-tenant in the
# tenant-runtime-template project (outside this module's scope).
# -----------------------------------------------------------------------------

resource "google_pubsub_topic" "governance_events" {
  project = google_project.platform_control.project_id
  name    = "governance-events-${var.environment}"

  message_retention_duration = "604800s" # 7 days

  depends_on = [google_project_service.apis]
}

# Grant platform-backend SA publisher rights too — platform-backend may
# publish kill-switch invalidations for admin-initiated pauses (e.g.
# "pause all agents for tenant X while we investigate a billing dispute").
resource "google_pubsub_topic_iam_member" "governance_events_platform_backend_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.governance_events.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

# tenant-runtime subscription on governance-events. Single shared subscription
# per environment — the subscriber dispatches by eventType attribute
# (kill_switch_changed, correction_captured, late_feedback_flagged,
# action_compensated). Without this declaration, tenant-runtime startup
# logs "governance events subscription error" and the subscriber retries
# against a nonexistent resource.
resource "google_pubsub_subscription" "governance_events_tenant_runtime" {
  project = google_project.platform_control.project_id
  name    = "governance-events-${var.environment}-tenant-runtime-sub"
  topic   = google_pubsub_topic.governance_events.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s" # 7 days
  enable_message_ordering    = false

  expiration_policy {
    ttl = "" # never expire
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# Each tenant runtime SA pulls from the shared subscription. The list is
# derived from allowed_governance_subscribers so onboarding a new dedicated
# tenant doesn't require editing this file — wire the SA email via the
# var in the env config.
resource "google_pubsub_subscription_iam_member" "governance_events_tenant_runtime_subscriber" {
  for_each = toset(var.allowed_governance_subscribers)

  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.governance_events_tenant_runtime.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${each.value}"
}

# -----------------------------------------------------------------------------
# Phase 4: per-service governance-events subscriptions
# -----------------------------------------------------------------------------
# When SERVICE_TYPE != monolith, src/governance/governance-events-subscriber.ts
# constructs `governance-events-{env}-{service_type}-sub`. That subscription
# must exist BEFORE the split service boots (the library retries against a
# non-existent resource and logs on every retry). Provisioning it up-front
# avoids the noisy retry loop on first rollout.
#
# `split_governance_subscriber_service_types` lists every split SERVICE_TYPE
# that runs the governance events subscriber. Keep in sync with src/index.ts.
# Agent-service is the primary subscriber today — it owns the preflight cache
# that kill-switch events invalidate.

variable "split_governance_subscriber_service_types" {
  description = <<-EOT
    Gate: list of split SERVICE_TYPE values that run the governance
    events subscriber. Each value gets its own subscription on
    governance-events-{env} so Pub/Sub fans messages out to every interested
    service (subscriptions, unlike subscribers, don't load-balance across
    subscribers on different subscription names).

    Empty list = no split subscriptions (monolith-only, current default).
    Flip to ["agent"] after the split services are deployed and ready to
    consume. Sync with src/index.ts' ownership matrix.
  EOT
  type        = list(string)
  default     = []
}

resource "google_pubsub_subscription" "governance_events_split" {
  for_each = toset(var.split_governance_subscriber_service_types)

  project = google_project.platform_control.project_id
  name    = "governance-events-${var.environment}-${each.value}-sub"
  topic   = google_pubsub_topic.governance_events.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  enable_message_ordering    = false

  expiration_policy {
    ttl = ""
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

resource "google_pubsub_subscription_iam_member" "governance_events_split_subscriber" {
  for_each = {
    for pair in setproduct(var.split_governance_subscriber_service_types, var.allowed_governance_subscribers) :
    "${pair[0]}::${pair[1]}" => { service_type = pair[0], subscriber_sa = pair[1] }
  }

  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.governance_events_split[each.value.service_type].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${each.value.subscriber_sa}"
}

# -----------------------------------------------------------------------------
# Billing: invocation-completed Pub/Sub topic + push subscription
# Tenant-runtime publishes per-invocation cost events;
# platform-backend spend-subscriber updates billing_controls.current_period_spend_usd.
# Threshold charging is handled by Stripe Metronome auto-recharge contracts —
# the Cloud Tasks queue originally planned here is no longer needed.
# -----------------------------------------------------------------------------

# Dead letter topic for undeliverable invocation-completed events
resource "google_pubsub_topic" "invocation_completed_dlq" {
  project = google_project.platform_control.project_id
  name    = "invocation-completed-dlq-${var.environment}"

  message_retention_duration = "604800s" # 7 days

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "invocation_completed" {
  project = google_project.platform_control.project_id
  name    = "invocation-completed-${var.environment}"

  message_retention_duration = "604800s" # 7 days

  depends_on = [google_project_service.apis]
}

# Tenant-runtime SAs publish invocation.completed events (same set as
# governance-events publishers — one SA per dedicated tenant runtime).
resource "google_pubsub_topic_iam_member" "invocation_completed_publisher" {
  for_each = toset(var.allowed_governance_subscribers)

  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.invocation_completed.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${each.value}"
}

# Dedicated SA for Pub/Sub OIDC push auth. Platform-backend's spend-subscriber
# validates that incoming push requests carry an OIDC token signed by this SA.
resource "google_service_account" "billing_pubsub_push" {
  project      = google_project.platform_control.project_id
  account_id   = "billing-pubsub-push-${var.environment}"
  display_name = "Billing Pub/Sub Push Invoker — ${var.environment}"
  description  = "SA impersonated by Pub/Sub when pushing invocation-completed events to platform-backend"
}

# Pub/Sub service agent must be able to generate OIDC tokens for the push SA.
# The Pub/Sub service agent email format is service-{project_number}@gcp-sa-pubsub.iam.gserviceaccount.com
resource "google_service_account_iam_member" "billing_pubsub_push_token_creator" {
  service_account_id = google_service_account.billing_pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# Push subscription: Pub/Sub delivers to platform-backend's billing spend-event
# endpoint. ACK deadline 60s gives the subscriber time to enqueue the Cloud
# Tasks task. DLQ after 5 failed deliveries.
resource "google_pubsub_subscription" "invocation_completed_push" {
  project = google_project.platform_control.project_id
  name    = "invocation-completed-${var.environment}-spend-sub"
  topic   = google_pubsub_topic.invocation_completed.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  enable_message_ordering    = false

  expiration_policy {
    ttl = "" # never expire
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.invocation_completed_dlq.id
    max_delivery_attempts = 5
  }

  push_config {
    push_endpoint = "${module.platform_backend.service_uri}/api/internal/billing/spend-event"

    oidc_token {
      service_account_email = google_service_account.billing_pubsub_push.email
      audience              = module.platform_backend.service_uri
    }
  }
}

# Platform-backend SA needs subscriber role to receive DLQ notifications
# and to allow platform-backend to pull/ack from DLQ for reconciliation.
resource "google_pubsub_subscription_iam_member" "invocation_completed_dlq_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.invocation_completed_push.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Dead-letter subscriber so platform-backend can drain and inspect failed events
resource "google_pubsub_subscription" "invocation_completed_dlq_drain" {
  project = google_project.platform_control.project_id
  name    = "invocation-completed-dlq-${var.environment}-drain-sub"
  topic   = google_pubsub_topic.invocation_completed_dlq.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_subscription_iam_member" "invocation_completed_dlq_drain_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.invocation_completed_dlq_drain.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Alert when DLQ receives messages — indicates repeated push delivery failures
resource "google_monitoring_alert_policy" "invocation_completed_dlq" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Billing: invocation-completed DLQ has messages (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "DLQ message count > 0"
    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=\"invocation-completed-dlq-${var.environment}-drain-sub\" AND metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "60s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.slack[0].name]

  documentation {
    content = "Pub/Sub failed to push invocation-completed events to platform-backend after 5 retries. Check /api/internal/billing/spend-event endpoint health and Cloud Run logs."
  }
}

# Grant Pub/Sub service agent publish rights to DLQ topic (required for
# dead_letter_policy to function — Pub/Sub must be able to publish to the DLQ)
resource "google_pubsub_topic_iam_member" "invocation_completed_dlq_pubsub_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.invocation_completed_dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "invocation_completed_pubsub_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.invocation_completed_push.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# -----------------------------------------------------------------------------
# Web-Tool Events Pub/Sub (Phase 4: sub-minute real-time billing)
#
# Web-tool spend events (perplexity, anchor, firecrawl, webclaw, browserbase)
# flow on a dedicated topic separate from invocation-completed (which is
# LLM-shaped). The push subscriber lands rows into cost_attribution_events
# via the SAME ingestEventWithBuckets boundary as the polled ingester, so
# bucket math + Stripe meter emission are identical across both paths.
# Ingester (Phase 0) remains the backstop.
# -----------------------------------------------------------------------------

resource "google_pubsub_topic" "web_tool_events_dlq" {
  project                    = google_project.platform_control.project_id
  name                       = "web-tool-events-dlq-${var.environment}"
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.apis]
}

resource "google_pubsub_topic" "web_tool_events" {
  project                    = google_project.platform_control.project_id
  name                       = "web-tool-events-${var.environment}"
  message_retention_duration = "604800s"
  depends_on                 = [google_project_service.apis]
}

# Tenant-runtime SAs publish web-tool events (same set as invocation-completed
# publishers — one SA per dedicated tenant runtime).
resource "google_pubsub_topic_iam_member" "web_tool_events_publisher" {
  for_each = toset(var.allowed_governance_subscribers)

  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.web_tool_events.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${each.value}"
}

resource "google_service_account" "web_tool_pubsub_push" {
  project      = google_project.platform_control.project_id
  account_id   = "web-tool-pubsub-push-${var.environment}"
  display_name = "Web-Tool Pub/Sub Push Invoker — ${var.environment}"
  description  = "SA impersonated by Pub/Sub when pushing web-tool-events to platform-backend"
}

resource "google_service_account_iam_member" "web_tool_pubsub_push_token_creator" {
  service_account_id = google_service_account.web_tool_pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription" "web_tool_events_push" {
  project = google_project.platform_control.project_id
  name    = "web-tool-events-${var.environment}-spend-sub"
  topic   = google_pubsub_topic.web_tool_events.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  enable_message_ordering    = false

  expiration_policy { ttl = "" }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.web_tool_events_dlq.id
    max_delivery_attempts = 5
  }

  push_config {
    push_endpoint = "${module.platform_backend.service_uri}/api/internal/billing/web-tool-event"

    oidc_token {
      service_account_email = google_service_account.web_tool_pubsub_push.email
      audience              = module.platform_backend.service_uri
    }
  }
}

resource "google_pubsub_subscription_iam_member" "web_tool_events_dlq_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.web_tool_events_push.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_pubsub_subscription" "web_tool_events_dlq_drain" {
  project = google_project.platform_control.project_id
  name    = "web-tool-events-dlq-${var.environment}-drain-sub"
  topic   = google_pubsub_topic.web_tool_events_dlq.id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  expiration_policy { ttl = "" }
}

resource "google_pubsub_subscription_iam_member" "web_tool_events_dlq_drain_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.web_tool_events_dlq_drain.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_monitoring_alert_policy" "web_tool_events_dlq" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Billing: web-tool-events DLQ has messages (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "DLQ message count > 0"
    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=\"web-tool-events-dlq-${var.environment}-drain-sub\" AND metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "60s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.slack[0].name]

  documentation {
    content = "Pub/Sub failed to push web-tool events to platform-backend after 5 retries. Check /api/internal/billing/web-tool-event endpoint health and Cloud Run logs. Phase-0 ingester remains the backstop — verify cost_attribution_events is still landing rows within 15-min cadence."
  }
}

# -----------------------------------------------------------------------------
# Deep research: revenue-loss event alert (D7).
# Fires on any of: precharge_lost, delta_lost, reconciler_emit_failed,
# registry_finalize_lost, outbox_giving_up. With the reconciler in place,
# a single precharge_lost or delta_lost is recoverable; outbox_giving_up
# (20 retries exhausted) is the irrecoverable signal that needs human
# intervention.
#
# Uses condition_matched_log (not condition_threshold) because Cloud Monitoring
# metric filters reject OR on jsonPayload prefixes; Cloud Logging filters
# (which condition_matched_log uses) accept them natively. Each matching log
# entry triggers the alert; notification_rate_limit debounces to once per 5min
# so a burst of failures produces one ping, not N.
# -----------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "deep_research_revenue_loss" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Deep research: revenue-loss event (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "revenue-loss log event matched"
    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND (jsonPayload.message="deep_research_precharge_lost"
          OR jsonPayload.message="deep_research_delta_lost"
          OR jsonPayload.message="deep_research_reconciler_emit_failed"
          OR jsonPayload.message="deep_research_registry_finalize_lost"
          OR jsonPayload.message="deep_research_outbox_giving_up")
      EOT
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "300s"
    }
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.slack[0].name]
  documentation {
    content = "A deep_research revenue/billing event was lost or unrecoverable. Check the matching log line in Cloud Logging. Recoverable signals: precharge_lost/delta_lost (reconciler will backstop); reconciler_emit_failed (outbox will retry); registry_finalize_lost (next reconciler cycle will retry). IRRECOVERABLE: deep_research_outbox_giving_up — 20 retries exhausted; original payload preserved in tenant-runtime deep_research_outbox.payload_json. Manual replay required."
  }
}

# -----------------------------------------------------------------------------
# Deep research: observability-signals log-based counter metric (D7).
# Counts each matching log entry. The companion alert thresholds the count
# at 5/hr so single-event transient blips don't page. Cannot use OR on
# jsonPayload in a Cloud Monitoring filter, so the log-based metric does the
# OR filtering up-front and the alert reads from the resulting counter.
# -----------------------------------------------------------------------------
resource "google_logging_metric" "deep_research_observability_signals" {
  project = google_project.platform_control.project_id
  name    = "deep-research-observability-signals-${var.environment}"
  filter  = <<-EOT
    resource.type="cloud_run_revision"
    AND (jsonPayload.message="deep_research_heartbeat_stuck"
      OR jsonPayload.message="deep_research_reconciler_perplexity_unreachable"
      OR jsonPayload.message="deep_research_reconciler_perplexity_non_2xx"
      OR jsonPayload.message="deep_research_reconciler_no_api_key"
      OR jsonPayload.message="web_tool_event_publish_lost"
      OR jsonPayload.message="deep_research_outbox_enqueued")
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "deep_research_observability_degraded" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Deep research: observability degraded (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "observability event > 5 / hour"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/deep-research-observability-signals-${var.environment}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_DELTA"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.slack[0].name]
  documentation {
    content = "Deep research observability signals are sustained. Investigate root cause: reconciler can't reach Perplexity (network or key issue), heartbeat is failing (DB connectivity), or Pub/Sub publish is degraded (web_tool_events DLQ is the canary)."
  }

  depends_on = [google_logging_metric.deep_research_observability_signals]
}

# -----------------------------------------------------------------------------
# Deep research: outbox backlog (D7).
# DISTRIBUTION metric extracts backlog_count from the `deep_research_outbox_backlog`
# INFO log emitted by the drainer at 10s cadence. Cloud Logging only allows
# value_extractor on DISTRIBUTION value type — so we use a distribution and
# alert on its max value via ALIGN_MAX. Backlog > 50 sustained 15+ min
# indicates Pub/Sub or PB ingester is down.
# -----------------------------------------------------------------------------
resource "google_logging_metric" "deep_research_outbox_backlog" {
  project = google_project.platform_control.project_id
  name    = "deep-research-outbox-backlog-${var.environment}"
  filter  = "resource.type=\"cloud_run_revision\" AND jsonPayload.message=\"deep_research_outbox_backlog\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "1"
  }
  value_extractor = "EXTRACT(jsonPayload.backlog_count)"

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 64
      growth_factor      = 2.0
      scale              = 0.01
    }
  }
}

resource "google_monitoring_alert_policy" "deep_research_outbox_backlog_high" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Deep research: outbox backlog sustained (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "outbox backlog > 50 sustained 15min"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/deep-research-outbox-backlog-${var.environment}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 50
      duration        = "900s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MAX"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.slack[0].name]
  documentation {
    content = "Deep research outbox has >50 rows in retry loop sustained for 15+ min. Pub/Sub or PB ingester is likely down. Check web_tool_events_dlq alert first. Original payloads are preserved in tenant-runtime deep_research_outbox.payload_json — no data loss."
  }

  depends_on = [google_logging_metric.deep_research_outbox_backlog]
}

# -----------------------------------------------------------------------------
# Web tools: vendor spend threshold (D7).
# Surfaces vendor-spend-monitor's daily logs. Not deep_research-specific
# but consolidated here since the reconciler now provides real-time spend
# visibility for deep_research.
#
# Uses condition_matched_log (Cloud Logging filter; supports OR on jsonPayload)
# rather than condition_threshold (Cloud Monitoring filter; does not).
# -----------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "vendor_spend_threshold" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Web tools: vendor spend threshold (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "vendor spend signal matched"
    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND (jsonPayload.event="vendor_spend_high"
          OR jsonPayload.event="vendor_spend_unexpected")
      EOT
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "86400s"
  }

  notification_channels = [google_monitoring_notification_channel.slack[0].name]
  documentation {
    content = "Daily vendor-spend-monitor signal. vendor_spend_high = MTD spend hit 80% of tier limit (check jsonPayload.vendor). vendor_spend_unexpected = non-zero spend on a $0-budget vendor (config drift)."
  }
}

resource "google_pubsub_topic_iam_member" "web_tool_events_dlq_pubsub_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.web_tool_events_dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "web_tool_events_pubsub_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.web_tool_events_push.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# -----------------------------------------------------------------------------
# Cloud Tasks Queue
# Per Section 7: Durable bounded execution
# -----------------------------------------------------------------------------

resource "google_cloud_tasks_queue" "tenant_provisioning" {
  project  = google_project.platform_control.project_id
  name     = "tenant-provisioning-${var.environment}"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 10
    max_dispatches_per_second = 5
  }

  retry_config {
    max_attempts       = 5
    min_backoff        = "1s"
    max_backoff        = "300s"
    max_doublings      = 4
    max_retry_duration = "3600s"
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_tasks_queue" "webhook_delivery" {
  project  = google_project.platform_control.project_id
  name     = "webhook-delivery-${var.environment}"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 100
    max_dispatches_per_second = 50
  }

  retry_config {
    max_attempts       = 10
    min_backoff        = "1s"
    max_backoff        = "600s"
    max_doublings      = 5
    max_retry_duration = "7200s"
  }

  depends_on = [google_project_service.apis]
}

# Per Section 2 & 11: Connector tasks via Cloud Tasks
# MCP chat runs (plan v6.1 Phase 5b): durable liftoff_chat worker dispatch.
# Same-project queue; tasks are named by chatRunId (at-least-once dedup) and
# target platform-backend's /api/internal/mcp-chat-runs/execute with OIDC
# from the invoker SA below. dispatchDeadline (600s) is set per-task by PB.
resource "google_cloud_tasks_queue" "mcp_chat_runs" {
  project  = google_project.platform_control.project_id
  name     = "mcp-chat-runs-${var.environment}"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 20
  }

  retry_config {
    max_attempts = 4
    min_backoff  = "5s"
    max_backoff  = "60s"
  }

  depends_on = [google_project_service.apis]
}

# OIDC identity the mcp-chat-runs tasks authenticate as. run.invoker on
# platform-backend itself (same project — trivial IAM, the whole point of
# the v6 same-project topology).
resource "google_service_account" "mcp_chat_runs_invoker" {
  project      = google_project.platform_control.project_id
  account_id   = "mcp-chat-runs-invoker"
  display_name = "MCP chat-run worker invoker (Cloud Tasks OIDC)"
}

resource "google_cloud_run_v2_service_iam_member" "mcp_chat_runs_invoker" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = module.platform_backend.service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.mcp_chat_runs_invoker.email}"
}

# platform-backend enqueues into THIS queue (queue-scoped grant — v6.1 audit
# fix D4: no project-wide enqueuer) and mints OIDC as the invoker SA.
resource "google_cloud_tasks_queue_iam_member" "platform_backend_chat_enqueuer" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = google_cloud_tasks_queue.mcp_chat_runs.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_service_account_iam_member" "platform_backend_actas_chat_invoker" {
  service_account_id = google_service_account.mcp_chat_runs_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Chat turns (Slack + Teams): durable inbound-message worker dispatch. The
# receive paths validate + dedupe + enqueue, then ack; the worker runs the
# whole turn inside its own request (cpu-throttled minScale-0 services get no
# guaranteed CPU after the ack). Tasks are named by a hash of the surface
# event id (at-least-once dedup) and target platform-backend's
# /api/internal/chat-turns/execute with OIDC from the invoker SA below.
# dispatchDeadline (600s) is set per-task by PB.
resource "google_cloud_tasks_queue" "chat_turns" {
  project  = google_project.platform_control.project_id
  name     = "chat-turns-${var.environment}"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 20
  }

  retry_config {
    max_attempts = 4
    min_backoff  = "5s"
    max_backoff  = "60s"
  }

  depends_on = [google_project_service.apis]
}

# OIDC identity the chat-turns tasks authenticate as; run.invoker on
# platform-backend itself (same-project topology, same as mcp-chat-runs).
resource "google_service_account" "chat_turns_invoker" {
  project      = google_project.platform_control.project_id
  account_id   = "chat-turns-invoker"
  display_name = "Chat-turn worker invoker (Cloud Tasks OIDC)"
}

resource "google_cloud_run_v2_service_iam_member" "chat_turns_invoker" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = module.platform_backend.service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.chat_turns_invoker.email}"
}

# platform-backend enqueues into THIS queue (queue-scoped grant, no
# project-wide enqueuer) and mints OIDC as the invoker SA.
resource "google_cloud_tasks_queue_iam_member" "platform_backend_chat_turns_enqueuer" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = google_cloud_tasks_queue.chat_turns.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_service_account_iam_member" "platform_backend_actas_chat_turns_invoker" {
  service_account_id = google_service_account.chat_turns_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Chat continuations: work a platform-assistant turn (Liftoff, the Insights
# Manager) could not finish inside one turn goes on as a job on the same
# thread. platform-backend queues one task per continuation row
# (chat_continuations, migration 514), named by the row, and the MCP chat-run
# worker serves it at /api/internal/mcp-chat-runs/continue with OIDC from the
# same invoker SA the mcp-chat-runs queue uses (run.invoker already granted
# above). dispatchDeadline (600s) is set per-task by platform-backend.
#
# A queue of its own because the retry policy differs from mcp-chat-runs'
# (maxAttempts 4): what makes a continuation retry is a thread lock that is
# BUSY (the turn that queued it still finishing, or a person talking), and
# that has to be re-delivered with backoff until the thread is free; a chat
# run that throws must not be re-run twenty times, each a paid turn. Twenty
# attempts, 5s to 60s with four doublings (the backoff reaches 60s and stays
# there: about fifteen minutes of attempts). The worker reads
# X-CloudTasks-TaskRetryCount and marks the row failed on the last delivery
# itself, so no row is left queued once this queue has given up.
resource "google_cloud_tasks_queue" "chat_continuations" {
  project  = google_project.platform_control.project_id
  name     = "chat-continuations-${var.environment}"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 20
  }

  retry_config {
    max_attempts  = 20
    min_backoff   = "5s"
    max_backoff   = "60s"
    max_doublings = 4
  }

  depends_on = [google_project_service.apis]
}

# platform-backend enqueues into THIS queue (queue-scoped grant, no
# project-wide enqueuer) and mints OIDC as the mcp-chat-runs invoker SA, on
# which it already holds serviceAccountUser (platform_backend_actas_chat_invoker).
resource "google_cloud_tasks_queue_iam_member" "platform_backend_chat_continuations_enqueuer" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = google_cloud_tasks_queue.chat_continuations.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_cloud_tasks_queue" "connector_tasks" {
  project  = google_project.platform_control.project_id
  name     = "connector-tasks-${var.environment}"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 30
    max_dispatches_per_second = 30
  }

  retry_config {
    max_attempts       = 5
    min_backoff        = "5s"
    max_backoff        = "600s"
    max_doublings      = 3
    max_retry_duration = "3600s"
  }

  depends_on = [google_project_service.apis]
}

# Per Section 7: Workflow task execution via Cloud Tasks
resource "google_cloud_tasks_queue" "workflow_tasks" {
  project  = google_project.platform_control.project_id
  name     = "workflow-tasks-${var.environment}"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 200
    max_dispatches_per_second = 100
  }

  retry_config {
    max_attempts       = 5
    min_backoff        = "1s"
    max_backoff        = "300s"
    max_doublings      = 4
    max_retry_duration = "3600s"
  }

  depends_on = [google_project_service.apis]
}

# Per Section 2 & 7: Action tasks queue with idempotency support
resource "google_cloud_tasks_queue" "action_tasks" {
  project  = google_project.platform_control.project_id
  name     = "action-tasks-${var.environment}"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 50
    max_dispatches_per_second = 50
  }

  retry_config {
    max_attempts       = 5
    min_backoff        = "2s"
    max_backoff        = "300s"
    max_doublings      = 4
    max_retry_duration = "1800s"
  }

  depends_on = [google_project_service.apis]
}

# Per Section 2 & 19: Maintenance tasks queue (for DR drills, cleanups, etc.)
resource "google_cloud_tasks_queue" "maintenance_tasks" {
  project  = google_project.platform_control.project_id
  name     = "maintenance-tasks-${var.environment}"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 5
    max_dispatches_per_second = 2
  }

  retry_config {
    max_attempts       = 3
    min_backoff        = "60s"
    max_backoff        = "3600s"
    max_doublings      = 2
    max_retry_duration = "14400s" # 4 hours per Section 2
  }

  # Every attempt logged. This queue carries the maintenance that used to run
  # on Cloud Scheduler, and an attempt's log line is the only record that it
  # ran, or why it failed. A few dozen tasks a day.
  stackdriver_logging_config {
    sampling_ratio = 1.0
  }

  depends_on = [google_project_service.apis]
}

# Billing threshold checks — decouples Stripe API latency from Pub/Sub ack.
# The Pub/Sub spend-event subscriber enqueues here immediately and ACKs;
# the task handler performs the actual Stripe InvoiceItem + PaymentIntent
# flow with full retry semantics.
resource "google_cloud_tasks_queue" "billing_threshold_checks" {
  project  = google_project.platform_control.project_id
  name     = "billing-threshold-checks-${var.environment}"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 100
    max_concurrent_dispatches = 50
  }

  retry_config {
    max_attempts       = 10
    min_backoff        = "10s"
    max_backoff        = "300s"
    max_doublings      = 5
    max_retry_duration = "3600s"
  }

  depends_on = [google_project_service.apis]
}

# HRBP per-spec fan-out queue. workforce-service enqueues one task per spec
# when a workforce plan is approved. Each task delivers OIDC-signed to
# workforce-service's /api/tasks/hrbp-provision-spec route, where HRBP runs
# (via runPlatformAgent) for that single spec.
#
# Concurrency is capped at 10 to bound platform-backend load on multi-spec
# plans. Retries on transient failures (5 attempts, exponential backoff).
resource "google_cloud_tasks_queue" "workforce_hrbp_fanout" {
  project  = google_project.platform_control.project_id
  name     = "workforce-hrbp-fanout-${var.environment}"
  location = var.region

  rate_limits {
    max_dispatches_per_second = 10
    max_concurrent_dispatches = 10
  }

  retry_config {
    max_attempts  = 5
    min_backoff   = "5s"
    max_backoff   = "300s"
    max_doublings = 3
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_tasks_queue_iam_member" "workforce_hrbp_fanout_enqueuer" {
  project  = google_cloud_tasks_queue.workforce_hrbp_fanout.project
  location = google_cloud_tasks_queue.workforce_hrbp_fanout.location
  name     = google_cloud_tasks_queue.workforce_hrbp_fanout.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${module.workforce_service.service_account_email}"
}

# When Cloud Tasks mints an OIDC token whose subject is the workforce SA, the
# principal that called createTask must hold `iam.serviceAccountUser` on the
# target SA. We use the same workforce SA for both ends of the call (enqueuer
# + OIDC subject), so the SA needs serviceAccountUser on itself. Without this
# binding every enqueue fails with HTTP 7 PERMISSION_DENIED on
# iam.serviceAccounts.actAs.
resource "google_service_account_iam_member" "workforce_self_actas" {
  count              = var.workforce_enabled ? 1 : 0
  service_account_id = "projects/${google_project.platform_control.project_id}/serviceAccounts/${module.workforce_service.service_account_email}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${module.workforce_service.service_account_email}"
}

# Cloud Tasks delivers OIDC-signed (subject = workforce SA) to the HRBP task
# handler on the workforce Cloud Run service. The Cloud Run invoker IAM check
# rejects the call unless the workforce SA holds run.invoker on the same
# service. Without this binding every delivery gets HTTP 403 and Cloud Tasks
# retries forever. Mirrors the connector_service_self_invoker pattern above.
resource "google_cloud_run_v2_service_iam_member" "workforce_self_invoker" {
  count    = var.workforce_enabled ? 1 : 0
  project  = google_project.platform_control.project_id
  location = var.region
  name     = module.workforce_service.service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.workforce_service.service_account_email}"
}

# The Chief AI Officer's chat continuations: the same design as
# chat-continuations-{env} above (a turn a bound closed with work still to do
# goes on as a job on the same thread), run in workforce-service, whose turns
# run there and whose chat_continuations table is in its own database. One
# task per row, named by the row, delivered OIDC-signed (subject = the
# workforce SA, as the HRBP fan-out is) to workforce-service's
# /api/tasks/chat-continuation. The same retry policy, for the same reason.
resource "google_cloud_tasks_queue" "workforce_chat_continuations" {
  project  = google_project.platform_control.project_id
  name     = "workforce-chat-continuations-${var.environment}"
  location = var.region

  rate_limits {
    max_concurrent_dispatches = 20
  }

  retry_config {
    max_attempts  = 20
    min_backoff   = "5s"
    max_backoff   = "60s"
    max_doublings = 4
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_tasks_queue_iam_member" "workforce_chat_continuations_enqueuer" {
  project  = google_cloud_tasks_queue.workforce_chat_continuations.project
  location = google_cloud_tasks_queue.workforce_chat_continuations.location
  name     = google_cloud_tasks_queue.workforce_chat_continuations.name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${module.workforce_service.service_account_email}"
}

# -----------------------------------------------------------------------------
# Artifact Registry for Container Images
# -----------------------------------------------------------------------------

resource "google_artifact_registry_repository" "platform" {
  project       = google_project.platform_control.project_id
  location      = var.region
  repository_id = "YOUR_GCP_PROJECT${var.environment}"
  format        = "DOCKER"
  description   = "Container images for Liftoff Platform"

  # Per Section 20: CMEK encryption for Artifact Registry
  kms_key_name = google_kms_crypto_key.artifact_registry.id

  # Vulnerability scanning bills per unique image scanned. Without retention,
  # every SHA ever built accumulates forever and rescans recur on re-tagging.
  # Keep the 20 newest versions per image and garbage-collect anything older
  # than 30 days. dry_run=false so the policy actually deletes.
  cleanup_policy_dry_run = false

  # Five newest per image: enough to roll back, and every Cloud Run job is
  # re-pinned to the newest image on each deploy. Twenty per image cost
  # ~$70/mo of storage for an environment with no traffic.
  cleanup_policies {
    id     = "keep-recent-versions"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }

  cleanup_policies {
    id     = "delete-older-than-7d"
    action = "DELETE"
    condition {
      older_than = "604800s"
    }
  }

  depends_on = [
    google_project_service.apis,
    google_kms_crypto_key_iam_member.artifactregistry_key
  ]
}

# NPM registry for shared packages (e.g., @liftoffos/mcp-transports)
#
# No cleanup policy, on purpose. Every package here is an @liftoffos/* library
# that other repos pin in a lockfile, and a pinned version that has been
# deleted fails that repo's next `npm ci` — silently, weeks later, in whichever
# service happens not to have been rebuilt within the window. A delete-older-
# than-30-days rule would reap versions other services still pin, leaving them
# undeployable. An npm tarball is kilobytes; keeping every
# version of every package costs cents a month. Retention of a published
# library version is not a storage decision.
resource "google_artifact_registry_repository" "npm_packages" {
  project       = google_project.platform_control.project_id
  location      = var.region
  repository_id = "npm-packages-${var.environment}"
  format        = "NPM"
  description   = "NPM packages for Liftoff shared libraries"

  # Per Section 20: CMEK encryption for Artifact Registry
  kms_key_name = google_kms_crypto_key.artifact_registry.id

  depends_on = [
    google_project_service.apis,
    google_kms_crypto_key_iam_member.artifactregistry_key
  ]
}

# GitHub Actions CI reads shared @liftoffos/* packages during `npm ci` in the
# test / audit / contract-test jobs. GH Actions federates (keyless WIF) from any
# LiftoffOS repo into the github-actions-{env} SA (see platform-ci/main.tf), which
# already had writer on the DOCKER repo (`YOUR_GCP_PROJECT`) but no grant on
# this NPM repo — so GH Actions `npm ci` 403'd on private @liftoffos deps. Reader
# is sufficient; CI only pulls. Mirrors the sandbox_images cloud-build writer grant.
resource "google_artifact_registry_repository_iam_member" "npm_packages_github_actions_reader" {
  project    = google_project.platform_control.project_id
  location   = var.region
  repository = google_artifact_registry_repository.npm_packages.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:github-actions-${var.environment}@YOUR_CI_PROJECT_${var.environment}.iam.gserviceaccount.com"
}

# aio-sandbox image registry. Built by sandbox-sidecar-{env} Cloud Build
# trigger in platform-ci and pulled by per-sandbox Cloud Run services in
# each tenant project. Google-managed encryption (not CMEK) because the
# image is the same across all tenants and the sandbox-sidecar build does
# not have CMEK encrypter access. Sandboxes pull by TAG, so only untagged
# versions are ever deleted: each push moves :latest and leaves the previous
# digest untagged, and with no policy those pile up quickly. A week
# outlives any sandbox still running on a superseded digest.
resource "google_artifact_registry_repository" "sandbox_images" {
  project       = google_project.platform_control.project_id
  location      = var.region
  repository_id = "sandbox-images"
  format        = "DOCKER"
  description   = "aio-sandbox images for tenant runtime sandboxes"

  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "delete-untagged-older-than-7d"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s"
    }
  }

  depends_on = [google_project_service.apis]
}

# cloud-build-{env} writes the image. Mirrors the writer binding on the
# `YOUR_GCP_PROJECT` repo used by the platform-backend build.
resource "google_artifact_registry_repository_iam_member" "sandbox_images_cloud_build_writer" {
  project    = google_project.platform_control.project_id
  location   = var.region
  repository = google_artifact_registry_repository.sandbox_images.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:cloud-build-${var.environment}@YOUR_CI_PROJECT_${var.environment}.iam.gserviceaccount.com"
}

# -----------------------------------------------------------------------------
# KMS for CMEK
# Per Section 20: KMS/CMEK for secrets and key control
# -----------------------------------------------------------------------------

resource "google_kms_key_ring" "main" {
  project  = google_project.platform_control.project_id
  name     = "keyring-${var.environment}"
  location = var.region

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "database" {
  name     = "database-key"
  key_ring = google_kms_key_ring.main.id

  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = false
  }
}

resource "google_kms_crypto_key" "secrets" {
  name     = "secrets-key"
  key_ring = google_kms_key_ring.main.id

  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = false
  }
}

# Per Section 20: CMEK key for Artifact Registry
resource "google_kms_crypto_key" "artifact_registry" {
  name     = "artifact-registry-key"
  key_ring = google_kms_key_ring.main.id

  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = false
  }
}

# Create Cloud SQL service identity before granting KMS access
resource "google_project_service_identity" "cloudsql" {
  provider = google-beta
  project  = google_project.platform_control.project_id
  service  = "sqladmin.googleapis.com"

  depends_on = [google_project_service.apis]
}

# Create Secret Manager service identity before granting KMS access
resource "google_project_service_identity" "secretmanager" {
  provider = google-beta
  project  = google_project.platform_control.project_id
  service  = "secretmanager.googleapis.com"

  depends_on = [google_project_service.apis]
}

# Grant Cloud SQL service account access to database key for CMEK
resource "google_kms_crypto_key_iam_member" "cloudsql_database_key" {
  crypto_key_id = google_kms_crypto_key.database.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.cloudsql.email}"

  depends_on = [google_project_service_identity.cloudsql]
}

# Grant Secret Manager service account access to secrets key for CMEK
resource "google_kms_crypto_key_iam_member" "secretmanager_secrets_key" {
  crypto_key_id = google_kms_crypto_key.secrets.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.secretmanager.email}"

  depends_on = [google_project_service_identity.secretmanager]
}

# Grant Secret Manager service agent access to database key — needed for
# data-export-orchestrator HMAC secret (CMEK with database-key).
resource "google_kms_crypto_key_iam_member" "secretmanager_database_key" {
  crypto_key_id = google_kms_crypto_key.database.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.secretmanager.email}"

  depends_on = [google_project_service_identity.secretmanager]
}

# Retrieve the GCS service agent email — GCP creates it automatically on first
# GCS operation; using the data source ensures the correct email is used.
data "google_storage_project_service_account" "gcs_sa" {
  project = google_project.platform_control.project_id
}

# Grant Cloud Storage service agent access to database key — needed for
# CMEK-encrypted GCS buckets (data-export-orchestrator export bucket).
resource "google_kms_crypto_key_iam_member" "gcs_database_key" {
  crypto_key_id = google_kms_crypto_key.database.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs_sa.email_address}"
}

# Grant the BigQuery CMEK service account access to the database key.
# BigQuery uses a project-scoped encryption SA (not a service identity) with the
# fixed format bq-{PROJECT_NUMBER}@bigquery-encryption.iam.gserviceaccount.com.
# This SA is created automatically by GCP when BigQuery is enabled.
resource "google_kms_crypto_key_iam_member" "bigquery_database_key" {
  crypto_key_id = google_kms_crypto_key.database.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:bq-${google_project.platform_control.number}@bigquery-encryption.iam.gserviceaccount.com"

  depends_on = [google_project_service.apis]
}

# Create Artifact Registry service identity before granting KMS access
resource "google_project_service_identity" "artifactregistry" {
  provider = google-beta
  project  = google_project.platform_control.project_id
  service  = "artifactregistry.googleapis.com"

  depends_on = [google_project_service.apis]
}

# Grant Artifact Registry service account access to artifact registry key for CMEK
resource "google_kms_crypto_key_iam_member" "artifactregistry_key" {
  crypto_key_id = google_kms_crypto_key.artifact_registry.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.artifactregistry.email}"

  depends_on = [google_project_service_identity.artifactregistry]
}

# -----------------------------------------------------------------------------
# Secret Manager - Initial Secrets Structure
# Per Section 12: Credentials for connectors
# -----------------------------------------------------------------------------

locals {
  # Secrets created with environment suffix (e.g., stripe-api-key-dev)
  # For new secrets, add here and in cloud_run_core_secrets below
  initial_secrets = [
    "stripe-api-key",
    "stripe-webhook-secret",
  ]

  # Note: LLM API keys (anthropic-api-key, openai-api-key) exist WITHOUT environment suffix
  # They are referenced directly in cloud_run_core_secrets below

  # OAuth secrets for connector integrations
  # Per Section 12: Credentials for connectors
  # IMPORTANT: When adding new OAuth integrations, add them here.
  # Terraform will automatically create secrets and mount them to Cloud Run.
  oauth_secrets = [
    "google-oauth-client-id",
    "google-oauth-client-secret",
    "slack-oauth-client-id",
    "slack-oauth-client-secret",
    "github-oauth-client-id",
    "github-oauth-client-secret",
    "microsoft-oauth-client-id",
    "microsoft-oauth-client-secret",
    "dropbox-oauth-client-id",
    "dropbox-oauth-client-secret",
    "box-oauth-client-id",
    "box-oauth-client-secret",
    "salesforce-oauth-client-id",
    "salesforce-oauth-client-secret",
    "hubspot-oauth-client-id",
    "hubspot-oauth-client-secret",
    "atlassian-oauth-client-id",
    "atlassian-oauth-client-secret",
    "zoom-oauth-client-id",
    "zoom-oauth-client-secret",
  ]

  # NOTE: connector-service-only OAuth apps (zendesk, docusign, bamboohr, …) are NOT
  # in `oauth_secrets` above — that list mounts to the platform-backend Cloud Run and
  # grants the platform-backend SA. Those vendors are consumed only by connector-service
  # (via its own cloudbuild `--set-secrets`), which reads them through its project-level
  # roles/secretmanager.secretAccessor. Their secrets are provisioned per-env with:
  #   gcloud secrets create <vendor>-oauth-client-id-<env>  (+ -secret) --replication-policy user-managed
  #     --locations <region> --kms-key-name <secrets-key> --labels type=oauth,environment=<env>,managed_by=terraform
  #   gcloud secrets versions add <vendor>-oauth-client-id-<env> --data-file=-

  # Generate environment variable names from secret names
  # e.g., "google-oauth-client-id" -> "GOOGLE_CLIENT_ID"
  oauth_secret_env_vars = {
    for secret in local.oauth_secrets : secret => upper(
      replace(
        replace(secret, "-oauth-client-", "_CLIENT_"),
        "-", "_"
      )
    )
  }

  # Generate Cloud Run secrets configuration
  # Maps secret names to environment variables for the cloud-run module
  cloud_run_oauth_secrets = [
    for secret in local.oauth_secrets : {
      name        = local.oauth_secret_env_vars[secret]
      secret_name = "${secret}-${var.environment}"
      version     = "latest"
    }
  ]

  # Core platform secrets for Cloud Run
  # IMPORTANT: When adding a new LLM provider API key to secret-manager module,
  # also add it here to mount it to Cloud Run as an environment variable.
  cloud_run_core_secrets = [
    {
      name        = "DB_PASSWORD"
      secret_name = google_secret_manager_secret.db_password.secret_id
      version     = "latest"
    },
    {
      name        = "STRIPE_SECRET_KEY"
      secret_name = "stripe-api-key-${var.environment}"
      version     = "latest"
    },
    {
      name        = "STRIPE_WEBHOOK_SECRET"
      secret_name = "stripe-webhook-secret-${var.environment}"
      version     = "latest"
    },
    # Server-side PostHog capture key (same phc_... project token the
    # frontend SDK uses; safe to expose since it's write-only). Read by
    # src/infrastructure/posthog.ts to fire server-only events that the
    # browser can't see (e.g. auto-reload outcomes from Stripe webhooks).
    # Unset in lower envs by default — the module no-ops without a key.
    {
      name        = "POSTHOG_KEY"
      secret_name = "POSTHOG_KEY"
      version     = "latest"
    },
    # LLM Provider API Keys
    # Note: These secrets exist without environment suffix (anthropic-api-key, openai-api-key)
    {
      name        = "ANTHROPIC_API_KEY"
      secret_name = "anthropic-api-key"
      version     = "latest"
    },
    {
      name        = "OPENAI_API_KEY"
      secret_name = "openai-api-key"
      version     = "latest"
    },
    # Composio managed-connector API key. Each GCP control-plane project
    # hosts its own composio-api-key secret pointing at a separate Composio
    # project (dev / prod), so no env suffix is needed.
    {
      name        = "COMPOSIO_API_KEY"
      secret_name = "composio-api-key"
      version     = "latest"
    },
    # Composio webhook signing secret — verifies HMAC on the
    # /api/internal/composio-webhook endpoint. One secret per Composio
    # project (dev / prod separately), no env suffix needed because each
    # control-plane project hosts its own.
    {
      name        = "COMPOSIO_WEBHOOK_SECRET"
      secret_name = "composio-webhook-secret"
      version     = "latest"
    },
    # Service-to-service auth for tenant runtime API calls
    {
      name        = "TENANT_RUNTIME_SERVICE_TOKEN"
      secret_name = "tenant-runtime-service-token"
      version     = "latest"
    },
    # Cross-service auth tokens — kept in sync with Cloud Build --update-secrets
    {
      name        = "CONNECTOR_SERVICE_TOKEN"
      secret_name = "connector-service-token"
      version     = "latest"
    },
    # Bearer token tenant-runtime (agent + tool-gateway services) sends on
    # X-Service-Auth for /api/internal/agent-slack/{installs,assignees,
    # post-review-dm,post-draft-dm}. Not a Slack-issued token. See secret
    # resource above for the full rationale.
    {
      name        = "AGENT_SLACK_SERVICE_TOKEN"
      secret_name = "agent-slack-service-token"
      version     = "latest"
    },
    # x402 wallet — the CDP server-wallet credentials, created in the CDP
    # portal and stored out-of-band (runbook: platform-backend
    # docs/runbooks/X402_WALLET_SETUP.md). connector-service mounts the same
    # three to SIGN vendor payments; platform-backend mounts them for the
    # treasury→spending auto-reload (jobs/x402-reload). Bare per-project
    # names, no environment suffix — the control project IS the environment.
    {
      name        = "CDP_API_KEY_ID"
      secret_name = "x402-cdp_api_key_id"
      version     = "latest"
    },
    {
      name        = "CDP_API_KEY_SECRET"
      secret_name = "x402-cdp_api_key_secret"
      version     = "latest"
    },
    {
      name        = "CDP_WALLET_SECRET"
      secret_name = "x402-cdp_wallet_secret"
      version     = "latest"
    },
    # Microsoft Teams — shared multi-tenant Liftoff bot + Graph creds. The bot
    # app id/password + Graph client secret originate in Azure (versions added
    # out-of-band, like the Anthropic/OAuth keys); AGENT_TEAMS_SERVICE_TOKEN is
    # the PB<->TR service-auth token (Terraform-managed, mirrors AGENT_SLACK).
    {
      name        = "AGENT_TEAMS_SERVICE_TOKEN"
      secret_name = "agent-teams-service-token"
      version     = "latest"
    },
    {
      name        = "TEAMS_BOT_APP_ID"
      secret_name = "teams-bot-app-id"
      version     = "latest"
    },
    {
      name        = "TEAMS_BOT_APP_PASSWORD"
      secret_name = "teams-bot-app-password"
      version     = "latest"
    },
    {
      name        = "TEAMS_GRAPH_CLIENT_SECRET"
      secret_name = "teams-graph-client-secret"
      version     = "latest"
    },
    # Liftoff Slack app identity (PB ADR-040) — ONE Slack app per environment
    # serves the connector AND the workspace bot; these are the SAME secrets
    # connector-service binds as SLACK_APP_ID / SLACK_SIGNING_SECRET. PB uses
    # them only to discriminate + verify inbound events/interactivity (the
    # OAuth install lives in connector-service, which delivers the bot token
    # via /api/internal/agent-slack/workspace-install).
    {
      name        = "LIFTOFF_SLACK_APP_ID"
      secret_name = "slack-app-id-${var.environment}"
      version     = "latest"
    },
    {
      name        = "LIFTOFF_SLACK_SIGNING_SECRET"
      secret_name = "slack-oauth-signing-secret-${var.environment}"
      version     = "latest"
    },
    {
      name        = "GOVERNANCE_SERVICE_TOKEN"
      secret_name = "governance-engine-token"
      version     = "latest"
    },
    # HMAC key for verifying requests from liftoff-billing internal API (Phase 0)
    {
      name        = "BILLING_SERVICE_TOKEN"
      secret_name = "billing-service-token"
      version     = "latest"
    },
    # Bearer token harvest-service sends on X-Service-Auth for internal harvest endpoints
    {
      name        = "HARVEST_SERVICE_TOKEN"
      secret_name = "harvest-service-token"
      version     = "latest"
    },
    # Bearer token liftoff-tunnel-service sends on X-Service-Auth for /api/internal/tunnel-*
    {
      name        = "TUNNEL_SERVICE_TOKEN"
      secret_name = "tunnel-service-token"
      version     = "latest"
    },
    # X-Service-Auth for /api/workforce-plans/* proxy to workforce-service.
    {
      name        = "WORKFORCE_SERVICE_TOKEN"
      secret_name = "workforce-service-token"
      version     = "latest"
    },
    # X-Service-Auth for governance evaluation calls (separate token from
    # GOVERNANCE_SERVICE_TOKEN — different surface, different rotation).
    {
      name        = "GOVERNANCE_EVAL_SERVICE_TOKEN"
      secret_name = "governance-eval-service-token"
      version     = "latest"
    },
    # BigQuery dataset name for cross-project GCP billing data (read by
    # gcp-billing-ingester). Stored as a secret because the dataset name
    # encodes the billing-export account ID.
    {
      name        = "GCP_BILLING_SHARED_BQ_DATASET"
      secret_name = "gcp-billing-shared-bq-dataset"
      version     = "latest"
    },
    # Bearer token developer-proxy posts on its webhook → PB receiver.
    {
      name        = "DEVELOPER_PROXY_WEBHOOK_TOKEN_SECRET"
      secret_name = "developer-proxy-webhook-token"
      version     = "latest"
    },
    # X-Service-Auth PB sends to developer-proxy's internal endpoints.
    {
      name        = "DEVELOPER_PROXY_SERVICE_TOKEN"
      secret_name = "developer-proxy-service-token"
      version     = "latest"
    },
    # Per-purpose Anthropic + OpenAI keys (env-suffixed so dev and prod
    # have separate billing/quotas/usage caps). Matches the model-provider
    # config in src/llm/*.
    {
      name        = "ANTHROPIC_API_KEY_AGENT_EXECUTION"
      secret_name = "anthropic-api-key-agent-execution-${var.environment}"
      version     = "latest"
    },
    {
      name        = "ANTHROPIC_API_KEY_REFLECTIVE_SERVICES"
      secret_name = "anthropic-api-key-reflective-services-${var.environment}"
      version     = "latest"
    },
    {
      name        = "ANTHROPIC_API_KEY_PLATFORM_ANALYTICS"
      secret_name = "anthropic-api-key-platform-analytics-${var.environment}"
      version     = "latest"
    },
    {
      name        = "ANTHROPIC_API_KEY_BACKGROUND_SERVICES"
      secret_name = "anthropic-api-key-background-services-${var.environment}"
      version     = "latest"
    },
    {
      name        = "OPENAI_API_KEY_AGENT_EXECUTION"
      secret_name = "openai-api-key-agent-execution-${var.environment}"
      version     = "latest"
    },
    {
      name        = "OPENAI_API_KEY_REFLECTIVE_SERVICES"
      secret_name = "openai-api-key-reflective-services-${var.environment}"
      version     = "latest"
    },
    {
      name        = "OPENAI_API_KEY_PLATFORM_ANALYTICS"
      secret_name = "openai-api-key-platform-analytics-${var.environment}"
      version     = "latest"
    },
    {
      name        = "OPENAI_API_KEY_BACKGROUND_SERVICES"
      secret_name = "openai-api-key-background-services-${var.environment}"
      version     = "latest"
    },
    # Apify platform token — read by the capability-discovery blueprint probe
    # runner (src/capability-discovery/probe-runner.ts). Bare (non-env-suffixed)
    # name: the secret is created per control project with that project's own
    # token (dev token in dev, prod token in prod). Absent-safe: the probe tier
    # is inert without it.
    {
      name        = "APIFY_PLATFORM_TOKEN"
      secret_name = "apify-platform-token"
      version     = "latest"
    },
    # TypeSafe (Jev) — the tool classifier, the distillation bind rung and the
    # chat routing rung (src/typesafe/client.ts). Bare per-project name, one
    # account per control project; the secret resource is
    # google_secret_manager_secret.typesafe_api_key below. Read as an env var
    # first, then Secret Manager (getTypeSafeApiKey).
    {
      name        = "TYPESAFE_API_KEY"
      secret_name = google_secret_manager_secret.typesafe_api_key.secret_id
      version     = "latest"
    },
  ]

  # All secrets for Cloud Run (core + OAuth)
  cloud_run_all_secrets = concat(local.cloud_run_core_secrets, local.cloud_run_oauth_secrets)
}

resource "google_secret_manager_secret" "initial" {
  for_each = toset(local.initial_secrets)

  labels = {
    type        = each.value == "stripe-webhook-secret" ? "webhook-secret" : "api-key"
    environment = var.environment
    managed_by  = "terraform"
  }

  project   = google_project.platform_control.project_id
  secret_id = "${each.value}-${var.environment}"

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

# Grant platform backend access to secrets
resource "google_secret_manager_secret_iam_member" "platform_backend_db_password" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.db_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_secret_manager_secret_iam_member" "platform_backend_db_connection" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.db_connection.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.platform_backend.email}"
}

# OAuth secrets for connector integrations
resource "google_secret_manager_secret" "oauth" {
  for_each = toset(local.oauth_secrets)

  project   = google_project.platform_control.project_id
  secret_id = "${each.value}-${var.environment}"

  labels = {
    type        = "oauth"
    environment = var.environment
    managed_by  = "terraform"
  }

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
    google_kms_crypto_key_iam_member.secretmanager_secrets_key
  ]
}

# Grant platform backend access to OAuth secrets
resource "google_secret_manager_secret_iam_member" "platform_backend_oauth" {
  for_each = toset(local.oauth_secrets)

  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.oauth[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Grant platform backend access to initial secrets (Stripe)
resource "google_secret_manager_secret_iam_member" "platform_backend_initial" {
  for_each = toset(local.initial_secrets)

  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.initial[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Anthropic purpose-group API keys (cost attribution pool — 4 keys, one per usage category)
# Secret names: anthropic-api-key-{group}-{env}
# These secrets are created manually via gcloud and imported here.
resource "google_secret_manager_secret" "anthropic_purpose_keys" {
  for_each = toset([
    "anthropic-api-key-agent-execution",
    "anthropic-api-key-reflective-services",
    "anthropic-api-key-platform-analytics",
    "anthropic-api-key-background-services",
  ])

  project   = google_project.platform_control.project_id
  secret_id = "${each.value}-${var.environment}"

  labels = {
    type        = "anthropic"
    environment = var.environment
    managed_by  = "terraform"
  }

  # These secrets were created via gcloud before Terraform managed them; gcloud
  # defaults to automatic (Google-managed) replication. Changing to user_managed
  # would force a replacement (replication is immutable), which prevent_destroy blocks.
  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [labels]
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "platform_backend_anthropic_keys" {
  for_each = toset([
    "anthropic-api-key-agent-execution",
    "anthropic-api-key-reflective-services",
    "anthropic-api-key-platform-analytics",
    "anthropic-api-key-background-services",
  ])

  project   = google_project.platform_control.project_id
  secret_id = "${each.value}-${var.environment}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.platform_backend.email}"
}

# OpenAI purpose-group API keys (cost attribution pool — 4 keys, one per usage category)
# Secret names: openai-api-key-{group}-{env}
# Mirrors the anthropic_purpose_keys block above. Like the Anthropic pool, the
# secret CONTAINER is managed here but the secret VERSION (the key material) is
# seeded out-of-band — copy the legacy `openai-api-key-${env}` value in with
# `gcloud secrets versions add` after apply. Terraform never holds key material.
resource "google_secret_manager_secret" "openai_purpose_keys" {
  for_each = toset([
    "openai-api-key-agent-execution",
    "openai-api-key-reflective-services",
    "openai-api-key-platform-analytics",
    "openai-api-key-background-services",
  ])

  project   = google_project.platform_control.project_id
  secret_id = "${each.value}-${var.environment}"

  labels = {
    type        = "openai"
    environment = var.environment
    managed_by  = "terraform"
  }

  # Match the Anthropic pool: automatic (Google-managed) replication so a later
  # gcloud-created/imported version cannot force a replacement.
  replication {
    auto {}
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [labels]
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "platform_backend_openai_keys" {
  for_each = toset([
    "openai-api-key-agent-execution",
    "openai-api-key-reflective-services",
    "openai-api-key-platform-analytics",
    "openai-api-key-background-services",
  ])

  project   = google_project.platform_control.project_id
  secret_id = "${each.value}-${var.environment}"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.platform_backend.email}"
}

# GCP Billing BigQuery export dataset path — non-sensitive pointer to the BQ table reference.
# Secret created manually; Terraform manages IAM and lifecycle from here.
resource "google_secret_manager_secret" "gcp_billing_bq_dataset" {
  labels    = { type = "config", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "gcp-billing-shared-bq-dataset"

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

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [
    google_project_service.apis,
    google_kms_crypto_key_iam_member.secretmanager_secrets_key,
  ]
}

resource "google_secret_manager_secret_iam_member" "platform_backend_billing_bq" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.gcp_billing_bq_dataset.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.platform_backend.email}"
}

# BigQuery jobUser — allows platform-backend to run queries against the billing export dataset.
resource "google_project_iam_member" "platform_backend_bigquery_job_user" {
  project = google_project.platform_control.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

# -----------------------------------------------------------------------------
# Platform-managed web-tool vendor API key
#
# Only Perplexity remains as a platform-shared web-tool vendor — its
# pricing model (pay-as-you-go per request, rate limits that scale with
# cumulative spend tier) lets a single Liftoff-owned account serve all
# tenants reliably. The other six web-tool vendors (webclaw, firecrawl,
# anchor_browser, browserbase, tavily, exa) are connection-required via
# the /connections page; they have no platform Secret Manager secrets
# (ADR-023). See
# tenant-runtime-template/main.tf → runtime_web_tool_keys for the
# cross-project accessor grant.
# -----------------------------------------------------------------------------

resource "google_secret_manager_secret" "perplexity_api_key" {
  labels    = { type = "api-key", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "perplexity-api-key"

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

# -----------------------------------------------------------------------------
# TypeSafe (Jev) API key
#
# One Liftoff-owned account per control project serves every tenant: the
# platform backend's tool classifier, distillation bind rung and chat routing
# rung, and every tenant runtime's browser loop, contract check, ask check,
# message check and memory checks (read cross-project through
# tenant-runtime-template/main.tf → runtime_web_tool_keys, the perplexity
# pattern). Same replication and CMEK as perplexity_api_key.
#
# If the two secrets were created by hand before this resource existed, the
# first apply in each environment IMPORTS rather than creates, through the `import` blocks in
# environments/<env>/main.tf (the pattern the pubsub subscription adoption
# used). A version is added out-of-band, as for every vendor key here.
# -----------------------------------------------------------------------------

resource "google_secret_manager_secret" "typesafe_api_key" {
  labels    = { type = "api-key", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "typesafe-api-key"

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

  lifecycle {
    # Imported: the replication and labels of a hand-created secret may differ
    # from this block, and a difference must never replace a secret whose
    # versions are the platform's key.
    prevent_destroy = true
    ignore_changes  = [labels, replication]
  }

  depends_on = [
    google_project_service.apis,
    google_kms_crypto_key_iam_member.secretmanager_secrets_key,
  ]
}

# The CI service account reads the key for the `typesafe-contract` build step
# in platform-backend's and tenant-runtime's cloudbuild.yaml, which runs the
# recorded fixture contract against the vendor and fails the build without it.
resource "google_secret_manager_secret_iam_member" "typesafe_api_key_cloud_build" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.typesafe_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:cloud-build-${var.environment}@YOUR_CI_PROJECT_${var.environment}.iam.gserviceaccount.com"
}

# -----------------------------------------------------------------------------
# Cloud Run - Platform Backend Service
# Per Section 2: Cloud Run for all services
# Managed by Terraform to ensure secrets are automatically synced
# -----------------------------------------------------------------------------

module "platform_backend" {
  source = "../../modules/cloud-run"

  project_id            = google_project.platform_control.project_id
  region                = var.region
  environment           = var.environment
  service_name          = "platform-backend"
  service_account_email = google_service_account.platform_backend.email

  # Image is updated by Cloud Build, Terraform ignores changes
  # Initial placeholder image - Cloud Build will update this
  image = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/${google_artifact_registry_repository.platform.repository_id}/platform-backend:${var.environment}"

  # Environment variables
  env_vars = {
    NODE_ENV       = "production"
    ENVIRONMENT    = var.environment
    GCP_PROJECT_ID = google_project.platform_control.project_id
    # Trace one root in ten (the OpenTelemetry SDK reads these when the code
    # passes no sampler, which @liftoffos/telemetry does not). Unsampled, the
    # service's own outbox and pool polls export a large volume of spans even
    # with almost no traffic; a sampled request still keeps its whole trace.
    OTEL_TRACES_SAMPLER     = "parentbased_traceidratio"
    OTEL_TRACES_SAMPLER_ARG = "0.1"
    # Where generated_files artifacts live. Set EXPLICITLY per environment
    # rather than left to the application default: that default is the
    # dev-named bucket, so an unset variable in prod would point production at
    # dev's storage. See generated-files-bucket.tf; the application now refuses
    # to start without this rather than falling back.
    GENERATED_FILES_BUCKET = google_storage_bucket.generated_files.name
    # Microsoft Teams bot home tenant (non-secret). The Azure Bot resource is
    # single-tenant, so the adapter authenticates SingleTenant against this
    # tenant; the backing Entra app registration is multi-tenant. Bot app
    # id/password come from Secret Manager (secret_env_vars). See platform-backend
    # src/agent-chat/teams-adapter/teams-bot-adapter.ts.
    TEAMS_BOT_APP_TENANT_ID   = "3205604e-67b0-4cbe-a0da-bc72f2e2ec1b"
    CLOUD_SQL_CONNECTION_NAME = google_sql_database_instance.control_plane.connection_name
    DB_USER                   = "liftoff_app"
    # Admin pool role for withAdminScope (BYPASSRLS). RLS FORCE enforcement
    # (platform-backend migration 287) requires this so cross-tenant workers,
    # batch ingesters, the audit-log batch writer, and pre-tenant-context auth
    # lookups bypass RLS instead of being silently filtered / errored. The admin
    # pool reuses DB_PASSWORD via getDbPassword() — liftoff_admin's DB password
    # is provisioned equal to control-plane-db-password in each env. See
    # platform-backend src/infrastructure/database.ts + docs/rls-todo.md.
    DB_ADMIN_USER = "liftoff_admin"
    # Hard-fail the startup admin-pool probe if the admin role lacks BYPASSRLS.
    # With RLS FORCE enabled, a non-bypass admin pool would SILENTLY filter
    # withAdminScope reads (empty/partial results) rather than error — this flag
    # turns that misconfiguration into a loud boot crash so a bad revision never
    # serves. Safe to enable: DB_ADMIN_USER=liftoff_admin passes the probe.
    LIFTOFF_REQUIRE_ADMIN_BYPASSRLS = "true"
    DB_NAME                         = "liftoff_control"
    # Public alias is env-specific:
    #   dev  → api-dev.example.com
    #   prod → api.example.com
    # PB's requireSchedulerOidc middleware uses this exact value as the
    # expected `aud` claim, so a token minted for prod cannot authenticate
    # against dev. Scheduler jobs in this module mint tokens with the same
    # audience — see the internal_agent_reconciler scheduler below.
    BACKEND_URL = var.environment == "prod" ? "https://api.example.com" : "https://api-${var.environment}.example.com"
    # MCP OAuth front door (plan v6.1). "false" = legacy behavior (.well-known
    # 404s, /mcp omits the WWW-Authenticate challenge). Flipped per env as the
    # Phase 6 release gate.
    MCP_OAUTH_ENABLED = var.mcp_oauth_enabled
    # Email-domain allow-list for the access gate (PB src/config/allowedDomains.ts).
    # Set here, it overrides Firebase Remote Config entirely for this service.
    #
    # Dev is restricted to staff addresses so a stray signup cannot reach the dev
    # workspace. Prod deliberately stays OPEN: its list lives in the Remote Config
    # server template, where the `*` entry admits every domain, and that template
    # is shared by both environments — which is exactly why dev needs an override
    # here rather than a change there. The empty string is falsy to the reader, so
    # prod keeps deferring to Remote Config and nothing about it changes.
    #
    # This must live in Terraform, not `gcloud run services update`: the cloud-run
    # module's ignore_changes covers only image and annotations, so Terraform owns
    # the full container env and reverts anything set out of band (INV-INFRA-007).
    ALLOWED_DOMAINS = var.environment == "prod" ? "" : "example.com"
    # OIDC identity of mcp-chat-runs Cloud Tasks deliveries; the worker
    # endpoint pins the token email to this SA.
    MCP_CHAT_RUNS_INVOKER_SA = google_service_account.mcp_chat_runs_invoker.email
    # OIDC identity of chat-turns (Slack/Teams) Cloud Tasks deliveries; the
    # worker endpoint pins the token email to this SA.
    CHAT_TURNS_INVOKER_SA = google_service_account.chat_turns_invoker.email
    # Per-env tunnel terminator hostname. Drives both the deploy-artifact
    # WS URL the customer's tunnel-client connects to AND the public_url
    # the dispatcher derives for each route. Must match the FQDN the
    # GCLB + cert + Cloudflare DNS in this env are bound to (see
    # tunnel_service.tf in this module).
    TUNNEL_BASE_DOMAIN         = var.tunnel_base_domain
    TUNNEL_TERMINATOR_ENDPOINT = "https://${var.tunnel_base_domain}"
    # Public prefix the UI hands operators for an agent's inbound webhook
    # URL — served from a dedicated `webhooks.example.com` subdomain
    # (env-specific) via the google_cloud_run_domain_mapping below.
    # Includes the /v1 version segment so PB's inboundUrl() helper is a
    # trivial concat. See platform-backend src/infrastructure/webhook-base-url.ts.
    WEBHOOK_BASE_URL = var.environment == "prod" ? "https://webhooks.example.com/v1" : "https://webhooks-${var.environment}.example.com/v1"
    # Bare hostname(s) the host-discipline middleware recognizes as the
    # dedicated webhook host. Comma-separated to allow listing multiple
    # without a code change (e.g. during a cert-cutover window). The
    # middleware partitions the URL namespace: webhook host serves ONLY
    # POST /v1/<token>; api host rejects /v1/* probes. Without this guard
    # the new subdomain would expose every /api/* route, since Cloud Run
    # domain mappings route host→service while Express dispatches by path.
    # See platform-backend src/infrastructure/host-discipline.ts.
    WEBHOOKS_HOST = var.environment == "prod" ? "webhooks.example.com" : "webhooks-${var.environment}.example.com"
    # Public frontend URL — used by:
    #   • src/notifications/email.ts for SETTINGS_LINK, ACTIVITY_LINK,
    #     REVIEW_LINK and the in-body Unsubscribe href that lands on the
    #     SPA's GlobalUnsubscribeHandler.
    #   • src/accounts/router.ts /verify-email redirect target.
    #   • src/infrastructure/email/content.ts welcome + payment-failed CTAs
    #     (via the {frontendUrl} BuildOptions placeholder).
    # The SPA is served from the YOUR_WEB_PROJECT Cloud Run project. Prod maps
    # example.com; dev maps dev.example.com (both Cloud Run domain mappings,
    # `gcloud beta run domain-mappings list --project=YOUR_WEB_PROJECT`). The dev
    # frontend is built with VITE_API_URL=api-dev.example.com, so its emails/
    # redirects must point at dev.example.com — otherwise dev flows (Slack
    # OAuth callback, invite/verify emails, HITL links) bounce testers to prod.
    FRONTEND_URL = var.environment == "dev" ? "https://dev.example.com" : "https://example.com"
    # Browser origins allowed by the CORS middleware (src/index.ts). When unset,
    # the code falls back to a hardcoded list that omits dev.example.com, so
    # the dev SPA's credentialed XHRs to api-dev would be blocked. Set per-env:
    # dev allows the dev host (+ localhost + dev run.app); the prod/staging
    # branch mirrors the existing code default byte-for-byte (no behavior change).
    CORS_ORIGIN = var.environment == "dev" ? "http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:3000,https://liftoff-react-dev-YOUR_PROJECT_HASH-uw.a.run.app,https://dev.example.com" : "http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:3000,https://liftoff-react-YOUR_PROJECT_HASH-uw.a.run.app,https://example.com"
    # WebAuthn relying party ID — must equal the frontend domain (or be a
    # registrable suffix of it). RP ID stays example.com in every env: it is a
    # registrable suffix of dev.example.com, so passkey ceremonies from the dev
    # host validate against the same RP (shared identity pool). Without this,
    # platform-backend falls
    # back to 'localhost' (see src/passkeys/service.ts) and browsers reject
    # passkey ceremonies with "The relying party ID is not a registrable
    # domain suffix of, nor equal to the current domain."
    PASSKEY_RP_ID      = "example.com"
    TENANT_RUNTIME_URL = var.tenant_runtime_url
    # Written to tenants.runtime_url at provisioning for shared-hosting
    # tenants (src/tenants/service.ts). Unset, every tenant gets a NULL
    # column and column-reading consumers 404; the shared runtime IS the
    # tenant runtime in each environment.
    SHARED_RUNTIME_URL = var.tenant_runtime_url
    # The GCP project whose service accounts may act for a SHARED-tier tenant.
    #
    # `tenants.gcp_project_id` is set only for the DEDICATED tier, so a shared
    # tenant has none, and platform-backend's strict caller check reads that
    # absence as "fail closed" — denying every shared tenant. Shared hosting is a supported tier, not a missing
    # configuration, so it needs a project to be checked AGAINST.
    #
    # Its own variable rather than something derived from tenant_runtime_url:
    # this is exactly the value that changes if the shared pool ever moves out
    # of the liftoffos project, and that move should be one variable here
    # rather than a code change in platform-backend.
    SHARED_RUNTIME_PROJECT_ID = var.shared_runtime_project_id != "" ? var.shared_runtime_project_id : "YOUR_TENANT_PROJECT${var.environment}"
    # Cross-service URLs resolved from module outputs — kept in sync with
    # Cloud Build's dynamic --update-env-vars so terraform apply never removes them.
    # The public hostname, not the run.app URL: a Cloud Run service calling
    # another is only "internal" when routed through the VPC, and connector-
    # service's ingress admits everything else through its load balancer.
    CONNECTOR_SERVICE_URL           = var.connector_service_enabled ? "https://connectors${local.public_host_suffix}.example.com" : ""
    GOVERNANCE_SERVICE_URL          = module.governance_engine.service_url
    DEVELOPER_PROXY_SERVICE_ENABLED = "new"
    DEVELOPER_PROXY_SERVICE_URL     = module.developer_proxy.service_url
    WORKFORCE_SERVICE_URL           = module.workforce_service.service_url
    BILLING_SERVICE_URL             = module.billing.service_url
    # Scheduler-OIDC verification (plan §6.4): PB's app-level requireSchedulerOidc
    # middleware checks inbound bearer tokens against this email. Cloud Run IAM
    # is open (invokers=["allUsers"]) so app-level verification is the only
    # thing standing between an unauthenticated caller and a global cross-tenant
    # reconciler fan-out.
    CLOUD_SCHEDULER_SA_EMAIL = google_service_account.scheduler.email
    # INF-5 of the deep-research-realtime-billing plan. PB's web-tool spend
    # subscriber (src/billing/web-tool-spend-subscriber.ts) verifies the
    # OIDC token attached to each Pub/Sub push against this SA email; if
    # unset, it falls back to a string derived from the env name which
    # breaks when the project is renamed. Wire from terraform output.
    WEB_TOOL_PUBSUB_PUSH_SA_EMAIL = google_service_account.web_tool_pubsub_push.email
    # Master kill-switch for the notifications delivery system (notifications
    # plan §10c). When unset/'false', enqueueNotification short-circuits before
    # inserting rows or invoking sendEmail — the audit-log + hitl-late-feedback
    # fanouts become no-ops, the hourly digest tick finds no candidates, and
    # no emails fire.
    #
    # Declared HERE in Terraform so `terraform apply` doesn't strip it on every
    # platform-control run: a value set via gcloud update-env-vars is wiped on
    # the next apply because the cloud-run module's env_vars block is
    # authoritative.
    #
    # Enabled in BOTH envs. The plan §10c gate: FE GlobalUnsubscribeHandler
    # live in prod (components/GlobalUnsubscribeHandler.tsx), plus an ops E2E
    # verification in dev.
    #
    # No backlog is released by flipping this on: the kill switch short-circuits
    # BEFORE repo.insertNotification, so while it is off no row is written and
    # the digest tick has nothing pending to drain. Digests carry only events
    # enqueued after the flip. The one same-week mass send is the Tuesday performance recap,
    # which is gated on the weeklyDigest toggle (defaulted true for every
    # account by migration 206) rather than on pending rows.
    NOTIFICATION_DELIVERY_ENABLED = "true"

    # Conversation Recall semantic retrieval v2 (recall-semantic-v2 project).
    # RECALL_EMBED_WRITE_ENABLED gates PB's inline embed-on-chat-turn write.
    # RECALL_SEMANTIC_READ_ENABLED gates the semantic recall query read path
    # (tri-state "true" | "shadow" | off). Declared HERE for the same reason as
    # NOTIFICATION_DELIVERY_ENABLED above: TF owns the full Cloud Run env, so a
    # flag set via `gcloud run services update` is wiped on the next apply. Both
    # envs currently run "true"; change the value here, never via gcloud.
    RECALL_EMBED_WRITE_ENABLED   = "true"
    RECALL_SEMANTIC_READ_ENABLED = "true"

    # Grants an annual subscriber every Operating Unit allowance after their
    # first; a monthly subscriber's arrives with each invoice, an annual
    # subscriber's does not. Declared HERE rather than via `gcloud run services
    # update` for the same reason as the flags above: TF owns the full Cloud Run
    # env, so a gcloud-set flag is wiped on the next apply. Paired with the
    # scheduler job in annual_plan_allocation_reset.tf, which is the only caller
    # of the endpoint this gates; the endpoint refuses with 503 when this is not
    # "true", so the two are set and unset together.
    ANNUAL_ALLOCATION_RESET_ENABLED = "true"

    # The x402 wallet's public address on Base, per environment (each env is
    # its own CDP project, so distinct addresses). Gates platform-backend's
    # treasury checks (src/jobs/x402-low-balance.ts, x402-reconcile.ts):
    # empty = wallet not live, both answer {skipped} at 200. Declared HERE
    # for the same reason as NOTIFICATION_DELIVERY_ENABLED — TF owns the full
    # Cloud Run env, so a value set via gcloud is wiped on the next apply.
    X402_WALLET_ADDRESS            = var.x402_wallet_address
    X402_LOW_BALANCE_THRESHOLD_USD = var.x402_low_balance_threshold_usd
    APIFY_PREPAID_TOKEN_USD        = var.apify_prepaid_token_usd

    # Pub/Sub push SA for billing event delivery — PB requires this to verify
    # the OIDC token on the /api/internal/billing/spend-event push subscription.
    BILLING_PUBSUB_PUSH_SA_EMAIL = "billing-pubsub-push-${var.environment}@${google_project.platform_control.project_id}.iam.gserviceaccount.com"

    # tenant-runtime project hosting the per-tenant metric writers PB queries
    # for internal-agent metrics aggregations.
    INTERNAL_AGENT_METRICS_PROJECT_ID = "YOUR_TENANT_PROJECT${var.environment}"

    # Cutover flag — workforce-service is the only path live in both envs.
    WORKFORCE_SERVICE_ENABLED = "new"

    # Pull subscription PB consumes for audit-event-driven notifications.
    AUDIT_EVENTS_SUBSCRIPTION = "audit-events-${var.environment}-platform-backend-sub"
  }

  # All secrets (core + OAuth) - automatically generated from oauth_secrets list
  secrets = local.cloud_run_all_secrets

  # Cloud SQL connection
  cloudsql_connections = [google_sql_database_instance.control_plane.connection_name]

  # VPC connector for private networking
  vpc_network_id    = google_compute_network.main.id
  vpc_subnetwork_id = google_compute_subnetwork.main.id

  # Reachable through the public-host load balancer (public_lb.tf); auth is
  # handled by the application. The invoker grant is what lets the load
  # balancer's traffic in; once `run_app_ingress_closed` is set the direct
  # run.app URL stops answering and only the load balancer and same-project
  # Google sources remain.
  ingress  = var.run_app_ingress_closed ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"
  invokers = ["allUsers"]

  # Resource configuration
  cpu           = "1"
  memory        = "1Gi"
  min_instances = 0
  max_instances = 10
  concurrency   = 80
  # 900s covers the longest synchronous endpoints (distill / redistill LLM
  # calls with maxTokens=16384 — Code Reviewer's run regularly stretches past
  # the prior 300s cap when the LLM emits a 9-step workflow + long instructionsMd).
  # Stays well under Cloud Run's 3600s hard maximum, so a runaway request is
  # still bounded.
  timeout           = 900
  startup_cpu_boost = true

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret.oauth,
    google_secret_manager_secret.initial,
    google_secret_manager_secret.db_password,
    google_sql_database_instance.control_plane,
    google_artifact_registry_repository.platform,
  ]
}

# -----------------------------------------------------------------------------
# webhooks.example.com (prod) / webhooks-${env}.example.com is served by the
# public-host load balancer (public_lb.tf), with the host-discipline middleware
# on the backend (src/infrastructure/host-discipline.ts) restricting the host
# to POST /v1/<token>. The Cloud Run domain mapping that used to carry it was
# removed once the host cut over: a mapping negotiates TLS 1.0 and cannot
# carry an SSL policy.
# -----------------------------------------------------------------------------

# Break-glass psql access to the platform control database.
#
# Mirrors tenant-runtime-psql in the tenant-runtime-template module — see
# docs/BREAK_GLASS_DB_ACCESS.md for the full rationale and runbook. Same
# shape: one Cloud Run job that runs psql inside the right VPC, reads its
# SQL from a QUERY env var overridden per execution:
#
#   gcloud run jobs execute platform-backend-psql \
#     --project=YOUR_CONTROL_PROJECT_STAGING --region=us-west1 \
#     --update-env-vars 'QUERY=SELECT COUNT(*) FROM internal_agents;' \
#     --wait
#
# Output is in the execution logs (Cloud Logging — filter by
# resource.labels.job_name="platform-backend-psql"). The job reuses the
# existing platform-backend-migrate image at :latest because it already
# has psql installed and the same DB credentials.
#
# Connection topology matches the migrate job: Cloud SQL Auth Proxy via
# Unix socket through cloudSqlInstances annotation, not direct private IP.
# That's why the env vars use CLOUD_SQL_CONNECTION_NAME instead of
# DB_HOST=10.212.x.x — the proxy sidecar exposes the DB at
# /cloudsql/<connection-name> and psql connects via -h <socket-dir>.
#
# WARNING: this job runs as the default compute SA, which has full project
# access. Anything you can express in SQL — including DROP TABLE — will
# execute. Treat like ssh-to-prod.
resource "google_cloud_run_v2_job" "psql_break_glass" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "platform-backend-psql"

  template {
    template {
      service_account = "${google_project.platform_control.number}-compute@developer.gserviceaccount.com"
      max_retries     = 0
      timeout         = "300s"

      vpc_access {
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.main.id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.control_plane.connection_name]
        }
      }

      containers {
        image = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/YOUR_GCP_PROJECT${var.environment}/platform-backend-migrate:latest"

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
            echo 'Run with: gcloud run jobs execute platform-backend-psql --update-env-vars QUERY="SELECT ..."'
            exit 1
          fi
          echo "Running query: $QUERY"
          PGPASSWORD="$DB_PASSWORD" psql -h "/cloudsql/$CLOUD_SQL_CONNECTION_NAME" -U "$DB_USER" -d "$DB_NAME" -c "$QUERY"
          EOT
        ]

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name  = "CLOUD_SQL_CONNECTION_NAME"
          value = google_sql_database_instance.control_plane.connection_name
        }
        env {
          name  = "DB_USER"
          value = "liftoff_app"
        }
        env {
          name  = "DB_NAME"
          value = "liftoff_control"
        }
        env {
          name  = "QUERY"
          value = "" # Always overridden via --update-env-vars at execute time
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_password.secret_id
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
      # Image is :latest and gets resolved at job creation. We don't want
      # every terraform apply to fight that resolution.
      template[0].template[0].containers[0].image,
      # client/client_version are stamped by cloudbuild's gcloud run deploy;
      # ignore so plans stay clean (matches push_endpoint_healthcheck/dlq_drainer).
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_sql_database_instance.control_plane,
    google_secret_manager_secret.db_password,
  ]
}

# The psql break-glass job runs as the default Compute SA (project-number-compute).
# Grant it secretAccessor on the DB credentials it needs to connect.
resource "google_secret_manager_secret_iam_member" "compute_sa_db_password" {
  secret_id = google_secret_manager_secret.db_password.secret_id
  project   = google_project.platform_control.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_project.platform_control.number}-compute@developer.gserviceaccount.com"
}

resource "google_secret_manager_secret_iam_member" "compute_sa_db_connection" {
  secret_id = google_secret_manager_secret.db_connection.secret_id
  project   = google_project.platform_control.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_project.platform_control.number}-compute@developer.gserviceaccount.com"
}

# Cloud SQL client access for the Compute SA — required by the Cloud SQL Auth
# Proxy sidecar on platform-backend-migrate (which runs as the default Compute SA).
resource "google_project_iam_member" "compute_sa_cloudsql_client" {
  project = google_project.platform_control.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_project.platform_control.number}-compute@developer.gserviceaccount.com"
}

# -----------------------------------------------------------------------------
# Cloud Scheduler for Automated Jobs
# Per Section 17: DR, restore, and reconcile - quarterly restore drill automation
# -----------------------------------------------------------------------------

# Service account for Cloud Scheduler to invoke Cloud Run jobs
resource "google_service_account" "scheduler" {
  project      = google_project.platform_control.project_id
  account_id   = "cloud-scheduler-${var.environment}"
  display_name = "Cloud Scheduler Service Account"

  depends_on = [google_project_service.apis]
}

# Grant scheduler permission to invoke Cloud Run
resource "google_project_iam_member" "scheduler_run_invoker" {
  project = google_project.platform_control.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}

# Grant scheduler permission to enqueue Cloud Tasks
resource "google_project_iam_member" "scheduler_tasks_enqueuer" {
  project = google_project.platform_control.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}

# Allow the GitHub Actions WIF SA (in YOUR_CI_PROJECT_${env}) to impersonate
# the scheduler SA so CI can mint OIDC id_tokens with `email=<scheduler SA>` —
# matching the email allowlist that PB's requireSchedulerOidc middleware
# enforces on /reconcile-runtime-state.
#
# Used by .github/workflows/integration.yml (PB repo) via the getSchedulerOidc
# helper. Granted via google_service_account_iam_member (NOT google_project_iam_member)
# so the binding is scoped to this specific SA, not all SAs in the project.
# platform-backend arms maintenance Cloud Tasks that carry THIS SA's identity
# (an OIDC token for its own /api/internal/* routes, which requireSchedulerOidc
# checks for this email, and an OAuth token for the Cloud Run job runs it
# triggers), so those routes and jobs need no second allow-list. Cloud Tasks
# requires actAs on the identity a task carries.
resource "google_service_account_iam_member" "platform_backend_act_as_scheduler" {
  service_account_id = google_service_account.scheduler.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_service_account_iam_member" "github_actions_impersonate_scheduler" {
  service_account_id = google_service_account.scheduler.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:github-actions-${var.environment}@YOUR_CI_PROJECT_${var.environment}.iam.gserviceaccount.com"
}

# Per Section 17: Quarterly restore drill for staging
# Runs first Sunday of each quarter at 2 AM UTC
resource "google_cloud_scheduler_job" "restore_drill" {
  count = var.environment == "staging" ? 1 : 0

  project     = google_project.platform_control.project_id
  name        = "restore-drill-${var.environment}"
  description = "Quarterly automated restore drill - validates backup/restore procedures"
  region      = var.region
  schedule    = "0 2 1-7 1,4,7,10 0" # First Sunday of Jan, Apr, Jul, Oct at 2 AM

  time_zone = "UTC"

  http_target {
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/restore-drill-job:run"
    http_method = "POST"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "60s"
    max_backoff_duration = "3600s"
  }

  depends_on = [google_project_service.apis]
}

# Reflection has no scheduled trigger. It is driven by events on the tenant
# runtime — reflection-engine's POST /evaluations, with triggerType selecting
# workflow_completed / workflow_failed / late_feedback. The `scheduled` intent
# that endpoint accepts has no caller; adding one means deciding which agents
# are due and how often, which is a product question, not a wiring one.
#
# A daily scheduler used to sit here posting to a platform-backend reflection
# endpoint that no longer exists.

# ── Slack config token rotation ──────────────────────────────────────────────
#
# Rotation runs as a Cloud Run Job (not an HTTP endpoint on the
# platform-backend service) so it cannot be interrupted by a service deploy.
#
# Failure mode this avoids:
#   1. Scheduler calls platform-backend's /api/internal/slack/rotate-config-token
#   2. Backend calls Slack tooling.tokens.rotate — Slack consumes the old
#      refresh token and returns a new pair
#   3. Cloud Run starts draining the instance for a deploy (SIGTERM, then
#      SIGKILL 10s later — Cloud Run's grace period is fixed at 10s and not
#      configurable)
#   4. The Secret Manager write of the new token pair is cut off mid-flight
#   5. The new pair is lost; Slack sees the old refresh token as consumed
#      → every subsequent rotation gets invalid_refresh_token
#
# Cloud Run Jobs are not subject to that lifecycle: once started they run to
# completion (bounded by their task timeout). The rotation logic is identical
# to the HTTP path — both call forceRotateSlackConfigToken() which holds the
# same PG advisory lock, so the two paths can't ever rotate simultaneously.
#
# The Job uses the same image as the platform-backend service, with a
# different entry point (dist/scripts/rotate-slack-token.js). cloudbuild
# updates the Job's image reference to the current SHA after each deploy.

# Phase 4 one-shot backfill: parse [[knowledge:...]] markers on existing
# agents, populate pinned_knowledge_ids, strip the legacy ## Knowledge
# section from system_prompt. Idempotent — re-runs are no-ops. Trigger:
#   gcloud run jobs execute backfill-pinned-knowledge-${var.environment} \
#     --project=${google_project.platform_control.project_id} \
#     --region=${var.region} --wait
resource "google_cloud_run_v2_job" "backfill_pinned_knowledge" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "backfill-pinned-knowledge-${var.environment}"

  template {
    template {
      service_account = google_service_account.platform_backend.email
      max_retries     = 0
      timeout         = "900s"

      vpc_access {
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.main.id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.control_plane.connection_name]
        }
      }

      containers {
        # Public Cloud Run placeholder for the initial Terraform creation —
        # the real platform-backend image is pushed under SHA tags only (no
        # :latest floats; vulnerability scanning bills per unique image, see
        # cloudbuild.yaml:303). The existing enterprise_orphan_scan job
        # references :latest because it was
        # created BEFORE cloudbuild dropped that tag and their state is
        # preserved by lifecycle.ignore_changes; new jobs can't use :latest.
        # Cloudbuild's "update-backfill-pinned-knowledge-job" step swaps this
        # placeholder for the deploy SHA tag on every push to main, mirroring
        # the slack-token-rotator pattern in cloudbuild.yaml.
        image   = "us-docker.pkg.dev/cloudrun/container/hello"
        command = ["node"]
        args    = ["dist/scripts/backfill-pinned-knowledge.js"]

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name  = "CLOUD_SQL_CONNECTION_NAME"
          value = google_sql_database_instance.control_plane.connection_name
        }
        env {
          name  = "DB_USER"
          value = "liftoff_app"
        }
        env {
          name  = "DB_NAME"
          value = "liftoff_control"
        }
        env {
          name  = "DB_HOST"
          value = "/cloudsql/${google_sql_database_instance.control_plane.connection_name}"
        }
        env {
          name  = "GCP_PROJECT_ID"
          value = google_project.platform_control.project_id
        }
        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_password.secret_id
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
      template[0].template[0].containers[0].image,
      # client/client_version are stamped by cloudbuild's gcloud run deploy;
      # ignore so plans stay clean (matches push_endpoint_healthcheck/dlq_drainer).
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.apis,
  ]
}

# -----------------------------------------------------------------------------
# PR 6 — enterprise-orphan-state scan job
# -----------------------------------------------------------------------------
#
# Read-only scan that lists enterprise accounts whose current snapshot has
# curated inconsistencies (per `inferHealthIssues`). Output drives the manual
# retroactive-cleanup procedure in
# docs/runbooks/ENTERPRISE_PROVISIONING.md (Post-PR-5 retroactive cleanup).
#
# Invoked manually by ops (NOT on a schedule) — the report is reviewed and
# each flagged tenant is cleaned up individually via PR 5's enterprise-setup
# endpoint with operator judgment per call:
#
#   gcloud run jobs execute platform-backend-enterprise-orphan-scan \
#     --project=YOUR_GCP_PROJECT<env> --wait
#
# Output goes to Cloud Logging (structured-payload JSON written to stdout).
resource "google_cloud_run_v2_job" "enterprise_orphan_scan" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "platform-backend-enterprise-orphan-scan"

  template {
    template {
      service_account = google_service_account.platform_backend.email
      max_retries     = 0
      # Stripe ops dominate; allow up to 5 minutes for scans of ~50 accounts.
      timeout = "600s"

      vpc_access {
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.main.id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.control_plane.connection_name]
        }
      }

      containers {
        # Initial placeholder — cloudbuild updates this to the deploy's SHA tag
        # on every push to main. Tag-only changes don't trigger Terraform drift
        # because we ignore the image attribute (lifecycle below).
        image   = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/YOUR_GCP_PROJECT${var.environment}/platform-backend:latest"
        command = ["node"]
        args    = ["dist/scripts/list-enterprise-accounts-with-orphan-state.js"]

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name  = "CLOUD_SQL_CONNECTION_NAME"
          value = google_sql_database_instance.control_plane.connection_name
        }
        env {
          name  = "DB_USER"
          value = "liftoff_app"
        }
        env {
          name  = "DB_NAME"
          value = "liftoff_control"
        }
        env {
          name  = "DB_HOST"
          value = "/cloudsql/${google_sql_database_instance.control_plane.connection_name}"
        }
        env {
          name  = "GCP_PROJECT_ID"
          value = google_project.platform_control.project_id
        }
        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_password.secret_id
              version = "latest"
            }
          }
        }
        # Stripe SDK access — readAccountState's Phase-2 calls
        # (subscriptions.list / subscriptions.search) read this secret.
        env {
          name = "STRIPE_SECRET_KEY"
          value_source {
            secret_key_ref {
              secret  = "stripe-api-key-${var.environment}"
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
    # cloudbuild owns the image SHA; don't trip drift on every Terraform plan.
    ignore_changes = [
      template[0].template[0].containers[0].image,
      # client/client_version are stamped by cloudbuild's gcloud run deploy;
      # ignore so plans stay clean (matches push_endpoint_healthcheck/dlq_drainer).
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_sql_database_instance.control_plane,
    google_secret_manager_secret.db_password,
  ]
}

# Chat delivery obligations — redeliver replies whose delivery died with the
# process that was making it (C1).
#
# Unlike the TTL sweeps around it, this is a RECOVERY job, so it runs on a short
# cadence rather than daily: the reply is already generated and paid for, and a
# person is waiting for it. The endpoint only touches obligations that have sat
# untouched for 10 minutes, so a 5-minute cadence never races a live delivery —
# it just means a stranded reply is found within ~15 minutes rather than a day.
# The maintenance endpoints must be called on the CANONICAL domain, not the
# service's own *.a.run.app URL.
#
# platform-backend 301-redirects any request whose Host is not the canonical
# domain. Cloud Scheduler does not follow redirects — it records the response as
# NOT_FOUND and the job counts as failed — so a maintenance job pointed at
# `service_uri` is silently dead: no event-delivery purge, no connector-content
# expiry, no Slack dedup cleanup.
locals {
  # Same expression already used for the OIDC audiences in this file.
  platform_backend_public_url = var.environment == "prod" ? "https://api.example.com" : "https://api-${var.environment}.example.com"
}

# -----------------------------------------------------------------------------
# Slack Notification Channel for Alert Policies
# Uses the "Liftoff Platform Alerts" Slack app
# -----------------------------------------------------------------------------

resource "google_monitoring_notification_channel" "slack" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
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

locals {
  notification_channels = var.slack_bot_token != "" ? [google_monitoring_notification_channel.slack[0].name] : []
}

# -----------------------------------------------------------------------------
# Observability - Application Log Sink
# Captures warnings and errors for operational visibility
# -----------------------------------------------------------------------------

module "observability" {
  source = "../../modules/observability"

  project_id     = google_project.platform_control.project_id
  environment    = var.environment
  retention_days = var.environment == "prod" ? 180 : 90

  depends_on = [google_project_service.apis]
}

# -----------------------------------------------------------------------------
# Workflow Alerting — Phase 6 alert policies
# Security events, validation rejections, catalog failures, DLQ backlog
# -----------------------------------------------------------------------------

module "workflow_alerting" {
  source = "../../modules/workflow-alerting"

  project_id            = google_project.platform_control.project_id
  environment           = var.environment
  notification_channels = local.notification_channels
}

# -----------------------------------------------------------------------------
# Connector Service (Phase 1 of platform decomposition)
# -----------------------------------------------------------------------------
# Scaffolded in commits d0d9c42 + 1163cc0. Instantiated here with
# enabled=false so the SA + IAM Conditions + VPC-SC plumbing is in place
# ahead of the first image push. Flip var.enabled=true once the
# connector-service Cloud Build trigger produces its first image.
module "connector_service" {
  source = "../../modules/connector-service"

  sql_connection_name = google_sql_database_instance.control_plane.connection_name

  project_id                = google_project.platform_control.project_id
  region                    = var.region
  environment               = var.environment
  platform_backend_sa_email = google_service_account.platform_backend.email

  # Phase 1a skeleton is on main; the first Cloud Build run will
  # publish the :dev tag to Artifact Registry and we flip this on.
  enabled = var.connector_service_enabled

  # See public_lb.tf `run_app_ingress_closed`.
  ingress = var.run_app_ingress_closed ? "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" : "INGRESS_TRAFFIC_ALL"

  # Real image is populated by cloudbuild.yaml; this is the tag it writes to.
  image = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/YOUR_GCP_PROJECT${var.environment}/connector-service:${var.environment}"

  # Share the platform-control VPC + serverless connector; Cloud SQL uses
  # private IP on the same network.
  network_id        = google_compute_network.main.id
  vpc_network_id    = google_compute_network.main.id
  vpc_subnetwork_id = google_compute_subnetwork.main.id
  min_instances     = var.connector_service_min_instances
  max_instances     = var.connector_service_max_instances

  # Bootstrap-only env vars. The runtime env (BACKEND_URL, FRONTEND_URL,
  # CLOUD_SQL_CONNECTION_NAME, COMMIT_SHA, SERVICE_VERSION, …) is owned by
  # `liftoff-connector-service/cloudbuild.yaml` via `gcloud run deploy
  # --set-env-vars`. The module's container resource has
  # `lifecycle.ignore_changes = [template[0].containers[0].env]` so a
  # subsequent `terraform apply` won't revert cloudbuild's runtime values.
  # Add new env vars HERE only if they're needed for first-deploy bring-up
  # (before cloudbuild has ever run); add to cloudbuild for everything else.
  env_vars = {
    LOG_LEVEL = "info"
  }

  # The connector_app SQL user password — connector-pg-password is the same
  # value, so the module reuses the random_password instance here to avoid
  # value drift between the secret and the SQL user.
  db_app_password = random_password.connector_db_password.result

  # CONNECTOR_SERVICE_TOKEN — shared bearer token for X-Service-Auth.
  # DB_PASSWORD — connector-pg user password.
  # COMPOSIO_API_KEY — Composio managed-OAuth + MCP API key (per-env
  # liftoff-{dev|prod} Composio project, see commit bfc64a8).
  #
  # Bootstrap-only: the runtime secret mounts (including all the per-vendor
  # OAuth client secrets) are owned by cloudbuild.yaml's `--set-secrets`.
  # `lifecycle.ignore_changes = [template[0].containers[0].env]` keeps
  # subsequent terraform applies from clobbering cloudbuild's values, so
  # these entries only matter for fresh-project bring-up.
  secrets = [
    {
      name        = "CONNECTOR_SERVICE_TOKEN"
      secret_name = "connector-service-token"
      version     = "latest"
    },
    {
      name        = "DB_PASSWORD"
      secret_name = "connector-pg-password"
      version     = "latest"
    },
    {
      name        = "COMPOSIO_API_KEY"
      secret_name = "composio-api-key"
      version     = "latest"
    },
  ]
}

# -----------------------------------------------------------------------------
# VPC Service Controls perimeter for the Connector Service (Phase 1 Fix 13).
#
# The module's default gates VPC-SC on var.environment == "prod" so dev and
# staging stay off until the Access Context Manager policy is provisioned
# for each environment. When the policy is ready, pass the access policy
# name + org id + allowed caller project numbers via the matching
# connector_service_security_* variables.
# -----------------------------------------------------------------------------

module "connector_service_security" {
  source = "../../modules/connector-service-security"

  # VPC-SC perimeter members must be project numbers, not project IDs.
  project_id                 = google_project.platform_control.number
  connector_service_sa_email = module.connector_service.service_account_email
  environment                = var.environment
  enabled                    = var.connector_service_security_enabled

  org_id                  = var.connector_service_security_org_id
  access_policy_name      = var.connector_service_security_access_policy_name
  allowed_caller_projects = var.connector_service_security_allowed_caller_projects
  admin_members           = var.connector_service_security_admin_members

  # Extra services in-VPC workloads may call (beyond restricted_services).
  # Prod sets storage.googleapis.com so the agent-diagnostics job's GCS
  # scorecard sink works under the VPC-SC vpc_accessible_services restriction.
  additional_vpc_accessible_services = var.connector_service_security_extra_vpc_services

  depends_on = [module.connector_service]
}

# -----------------------------------------------------------------------------
# Governance Engine (Phase 3 of platform decomposition)
# -----------------------------------------------------------------------------
# Instantiated here with enabled defaulting to false so the SA + Cloud SQL
# + secrets plumbing is in place ahead of the first image push. Flip
# var.governance_engine_enabled = true in the parent environment config
# (dev/prod) once the governance-engine Cloud Build trigger publishes its
# first image to Artifact Registry.
#
# VPC-SC for the Governance Engine is DEFERRED. The connector-service-security
# module pattern can be copied here once the governance-engine perimeter
# design is finalized.

module "governance_engine" {
  source = "../../modules/governance-engine"

  sql_connection_name = google_sql_database_instance.control_plane.connection_name

  project_id                = google_project.platform_control.project_id
  region                    = var.region
  environment               = var.environment
  platform_backend_sa_email = google_service_account.platform_backend.email

  # Default to false until the image exists. Set var.governance_engine_enabled
  # from the env config to flip it on.
  enabled = var.governance_engine_enabled == null ? false : var.governance_engine_enabled

  # The tag cloudbuild.yaml actually writes is the commit SHA plus `latest` —
  # never `:dev` / `:prod`. A `:${var.environment}` tag exists in neither
  # registry, so every Cloud Run Job built from this module would die on
  # "Image not found". The service itself would be unaffected because it
  # ignores image changes and cloudbuild deploys it directly, so nothing would
  # surface it.
  #
  # `latest` rather than a pinned digest deliberately: a pinned digest that
  # nobody remembers to bump goes stale. A maintenance job should track what
  # cloudbuild published.
  image = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/YOUR_GCP_PROJECT${var.environment}/governance-engine:latest"

  # Share the platform-control VPC + serverless connector; Cloud SQL uses
  # private IP on the same network.
  network_id        = google_compute_network.main.id
  vpc_network_id    = google_compute_network.main.id
  vpc_subnetwork_id = google_compute_subnetwork.main.id
  min_instances     = var.governance_engine_min_instances
  max_instances     = var.governance_engine_max_instances

  env_vars = {
    LOG_LEVEL = "info"
  }

  # The governance_app SQL user password — governance-pg-password is the
  # same value, so the module reuses the random_password instance here to
  # avoid value drift between the secret and the SQL user.
  db_app_password = random_password.governance_db_password.result

  # GOVERNANCE_SERVICE_TOKEN — shared bearer for X-Service-Auth (plan
  # convention). The underlying Secret Manager resource is still named
  # `governance-engine-token` for historical reasons — only the env var
  # name exposed in the container follows the new convention.
  # GOVERNANCE_PREFLIGHT_SIGNING_KEY — HMAC key for signed preflight tokens.
  # DB_PASSWORD — governance-pg user password.
  secrets = [
    {
      name        = "GOVERNANCE_SERVICE_TOKEN"
      secret_name = "governance-engine-token"
      version     = "latest"
    },
    {
      name        = "GOVERNANCE_PREFLIGHT_SIGNING_KEY"
      secret_name = "governance-preflight-signing-key"
      version     = "latest"
    },
    {
      name        = "DB_PASSWORD"
      secret_name = "governance-pg-password"
      version     = "latest"
    },
  ]

  depends_on = [
    google_secret_manager_secret_version.governance_pg_password,
    google_secret_manager_secret_version.governance_engine_token,
    google_secret_manager_secret_version.governance_preflight_signing_key,
    google_pubsub_topic.governance_events,
  ]
}

# -----------------------------------------------------------------------------
# Harvest Service — Cloud Run
# Consumes connector-events Pub/Sub, classifies records, writes to tenant-runtime memory.
# -----------------------------------------------------------------------------

resource "google_service_account" "harvest_service" {
  project      = google_project.platform_control.project_id
  account_id   = "harvest-service"
  display_name = "Harvest Service SA"
}

# --- Scale-to-zero push wiring ------------------------------------------------
# harvest-service consumes via Pub/Sub PUSH (not always-on streaming pull), so
# Cloud Run wakes on each event and scales back to zero between bursts. The push
# subscriptions and the hourly dedup-GC scheduler below deliver over OIDC to the
# service's HTTP endpoints; because the service is deployed
# --no-allow-unauthenticated (--ingress all), Cloud Run itself verifies the
# token at ingress and the app does not re-verify.
#
# The Cloud Run service is owned by liftoff-harvest-service/cloudbuild.yaml
# (harvest_service_enabled stays false — TF does not manage the compute), so we
# read its URL via a data source. This makes the platform-control apply depend
# on harvest-service already being deployed.
data "google_cloud_run_v2_service" "harvest" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "harvest-service"
}

# Identity Pub/Sub (and the dedup-GC scheduler) present to Cloud Run. Granted
# run.invoker on harvest-service; the Pub/Sub service agent may mint OIDC tokens
# as it. Mirrors the billing_pubsub_push pattern.
resource "google_service_account" "harvest_pubsub_push" {
  project      = google_project.platform_control.project_id
  account_id   = "harvest-pubsub-push-${var.environment}"
  display_name = "Harvest Pub/Sub push + scheduler OIDC — ${var.environment}"
  description  = "SA impersonated by Pub/Sub push + the dedup-GC scheduler to invoke harvest-service"
}

resource "google_service_account_iam_member" "harvest_pubsub_push_token_creator" {
  service_account_id = google_service_account.harvest_pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_cloud_run_v2_service_iam_member" "harvest_push_invoker" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "harvest-service"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.harvest_pubsub_push.email}"
}

# Daily dedup GC — replaces the in-process setInterval so the service can idle
# to zero. Pure storage: the dedup check is ON CONFLICT with no time filter, so
# rows living a day longer change nothing but the table's size.
resource "google_cloud_scheduler_job" "harvest_dedup_gc" {
  project   = google_project.platform_control.project_id
  region    = var.region
  name      = "harvest-dedup-gc-${var.environment}"
  schedule  = "0 15 * * *"
  time_zone = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "${data.google_cloud_run_v2_service.harvest.uri}/internal/dedup-gc"

    oidc_token {
      service_account_email = google_service_account.harvest_pubsub_push.email
      audience              = data.google_cloud_run_v2_service.harvest.uri
    }
  }

  retry_config {
    retry_count = 1
  }
}

resource "google_secret_manager_secret_iam_member" "harvest_service_token_access" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.harvest_service_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.harvest_service.email}"
}

# platform-backend reads harvest-service-token to validate X-Service-Auth on harvest internal routes
resource "google_secret_manager_secret_iam_member" "harvest_service_token_platform_backend_access" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.harvest_service_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_secret_manager_secret_iam_member" "harvest_tenant_runtime_token_access" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.harvest_tenant_runtime_service_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.harvest_service.email}"
}

resource "google_secret_manager_secret_iam_member" "harvest_pg_password_access" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.harvest_pg_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.harvest_service.email}"
}

resource "google_pubsub_subscription_iam_member" "harvest_service_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.harvest_connector_events.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.harvest_service.email}"
}

# Cloud SQL client access (needed to connect via Cloud SQL Auth Proxy)
resource "google_project_iam_member" "harvest_service_cloudsql_client" {
  project = google_project.platform_control.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.harvest_service.email}"
}

# Artifact Registry reader (image pull)
resource "google_artifact_registry_repository_iam_member" "harvest_service_ar_reader" {
  project    = google_project.platform_control.project_id
  location   = var.region
  repository = "YOUR_GCP_PROJECT${var.environment}"
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.harvest_service.email}"
}

# DLQ: Pub/Sub service agent needs publisher access to dead-letter topic
# and subscriber access to the source subscription for dead-letter routing
# to work.
resource "google_pubsub_topic_iam_member" "harvest_dlq_pubsub_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.harvest_dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "harvest_sub_pubsub_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.harvest_connector_events.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# -----------------------------------------------------------------------------
# Phase 3: connector.deleted cleanup — subscribe to control-plane-events
# -----------------------------------------------------------------------------

resource "google_pubsub_subscription" "harvest_control_plane_events" {
  project = google_project.platform_control.project_id
  name    = "control-plane-events-${var.environment}-harvest-sub"
  topic   = google_pubsub_topic.control_plane["control-plane-events"].id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = false

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.harvest_dlq.id
    max_delivery_attempts = 5
  }

  # PUSH (see harvest_connector_events). connector.deleted cleanup is fast DB
  # work, so the default 60s ack deadline is fine.
  push_config {
    push_endpoint = "${data.google_cloud_run_v2_service.harvest.uri}/pubsub/control-plane-events"

    oidc_token {
      service_account_email = google_service_account.harvest_pubsub_push.email
      audience              = data.google_cloud_run_v2_service.harvest.uri
    }
  }
}

resource "google_pubsub_subscription_iam_member" "harvest_control_plane_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.harvest_control_plane_events.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.harvest_service.email}"
}

# Pub/Sub service agent must be able to publish to the DLQ for dead-letter
# routing to work on harvest_control_plane_events.
resource "google_pubsub_topic_iam_member" "harvest_control_plane_dlq_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.harvest_dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# -----------------------------------------------------------------------------
# Phase 4: monthly re-harvest — secret access + Cloud Scheduler job
# -----------------------------------------------------------------------------

# harvest SA needs to read the connector-service-token to call connector-service
# during re-harvest runs.
resource "google_secret_manager_secret_iam_member" "harvest_service_connector_service_token_access" {
  project   = google_project.platform_control.project_id
  secret_id = google_secret_manager_secret.connector_service_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.harvest_service.email}"
}

resource "google_cloud_scheduler_job" "harvest_reharvest" {
  project          = google_project.platform_control.project_id
  region           = var.region
  name             = "harvest-reharvest-${var.environment}"
  schedule         = "0 2 1 * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "1800s"

  http_target {
    http_method = "POST"
    # The reharvest Cloud Run Job is created by liftoff-harvest-service/cloudbuild
    # as "${_SERVICE_NAME}-reharvest" = harvest-service-reharvest (no env suffix;
    # the project already scopes the env). The old target harvest-reharvest-${env}
    # never existed, so every fire returned NOT_FOUND (status.code 5).
    uri = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/harvest-service-reharvest:run"

    oauth_token {
      service_account_email = google_service_account.harvest_service.email
    }
  }

  retry_config {
    retry_count          = 1
    min_backoff_duration = "300s"
  }
}

resource "google_project_iam_member" "harvest_run_job_executor" {
  project = google_project.platform_control.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.harvest_service.email}"
}

resource "google_cloud_run_v2_service" "harvest_service" {
  count    = var.harvest_service_enabled == true ? 1 : 0
  project  = google_project.platform_control.project_id
  name     = "harvest-service"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account                  = google_service_account.harvest_service.email
    timeout                          = "300s"
    max_instance_request_concurrency = 8 # matches flow control max messages

    vpc_access {
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.main.id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    scaling {
      min_instance_count = var.harvest_service_min_instances
      max_instance_count = var.harvest_service_max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.control_plane.connection_name]
      }
    }

    containers {
      image = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/YOUR_GCP_PROJECT${var.environment}/harvest-service:${var.environment}"

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      # Plain env vars
      env {
        name  = "NODE_ENV"
        value = "production"
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
        name  = "DB_NAME"
        value = "harvest"
      }
      env {
        name  = "DB_USER"
        value = "harvest_app"
      }
      env {
        name  = "DB_SOCKET_PATH"
        value = "/cloudsql/${google_sql_database_instance.control_plane.connection_name}"
      }
      env {
        name  = "PLATFORM_BACKEND_URL"
        value = module.platform_backend.service_uri
      }

      # Secrets
      env {
        name = "HARVEST_SERVICE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.harvest_service_token.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "HARVEST_TENANT_RUNTIME_SERVICE_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.harvest_tenant_runtime_service_token.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.harvest_pg_password.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_sql_user.harvest_app,
    google_sql_database.harvest,
    google_secret_manager_secret_version.harvest_service_token,
    google_secret_manager_secret.harvest_tenant_runtime_service_token,
    google_secret_manager_secret_version.harvest_pg_password,
  ]

  lifecycle {
    # harvest-service is a cloudbuild-owns-env (Model-B) service: the
    # liftoff-harvest-service's cloudbuild sets the full runtime config via
    # `gcloud run deploy` --set-env-vars/--set-secrets (incl. CONNECTOR_SERVICE_URL,
    # SERVICE_VERSION, COMMIT_SHA that TF cannot know) plus --cpu/--memory/
    # --min-instances/--max-instances/--concurrency/--timeout/--vpc-connector.
    # Ignoring only the image (the prior state) meant a `terraform apply` would
    # strip cloudbuild's env vars, the exact reap that broke developer-proxy (#39).
    # Ignore the full cloudbuild-owned surface. Matches the connector-service /
    # developer-proxy / governance-engine / workforce-service pattern.
    # (Currently count=0 via harvest_service_enabled=false, so this is inert until
    # the service is enabled; declared now so enabling it does not footgun.)
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

# -----------------------------------------------------------------------------
# Harvest Service Observability (OPS-001)
# Log-based metrics + alert policies for harvest pipeline health.
# DLQ inspect subscription for ops visibility into poison-pill messages.
# -----------------------------------------------------------------------------

# Log-based metric: messages that reached the classifier (worthy + unworthy).
resource "google_logging_metric" "harvest_classified" {
  project = google_project.platform_control.project_id
  name    = "harvest_classified_total"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"harvest-service\" AND jsonPayload.metric=\"harvest_classified\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# Log-based metric: memories successfully written to tenant runtime.
resource "google_logging_metric" "harvest_written" {
  project = google_project.platform_control.project_id
  name    = "harvest_written_total"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"harvest-service\" AND jsonPayload.metric=\"harvest_written\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# Log-based metric: messages dropped at any stage (pre-filter, unworthy, etc.).
resource "google_logging_metric" "harvest_dropped" {
  project = google_project.platform_control.project_id
  name    = "harvest_dropped_total"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"harvest-service\" AND jsonPayload.metric=\"harvest_dropped\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# Alert: harvest subscription backlog > 5 minutes old. Indicates harvest-service
# is down or processing too slowly. Alert value in seconds (300 = 5 min).
resource "google_monitoring_alert_policy" "harvest_sub_oldest_unacked" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Harvest: subscription backlog > 5 minutes (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "oldest_unacked_message_age > 300s"
    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=\"connector-events-${var.environment}-harvest-sub\" AND metric.type=\"pubsub.googleapis.com/subscription/oldest_unacked_message_age\""
      comparison      = "COMPARISON_GT"
      threshold_value = 300
      duration        = "60s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = local.notification_channels

  documentation {
    content = "harvest-service subscription backlog is growing. Check harvest-service Cloud Run health, Cloud SQL connectivity, and LLM gateway availability."
  }
}

# Alert: harvest DLQ has messages — poison-pill records failed 5 times.
resource "google_monitoring_alert_policy" "harvest_dlq_has_messages" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Harvest: DLQ has messages (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "DLQ num_undelivered_messages > 0"
    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=\"connector-events-${var.environment}-harvest-dlq-inspect\" AND metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "60s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = local.notification_channels

  documentation {
    content = "Messages in the harvest DLQ have failed 5 delivery attempts. Inspect connector-events-${var.environment}-harvest-dlq-inspect subscription to see the message body, then debug using harvest-service logs for the relevant message_id."
  }
}

# DLQ inspect subscription: pull-based subscription on the DLQ topic so ops can
# read dead-lettered messages without them being re-queued for delivery.
resource "google_pubsub_subscription" "harvest_dlq_inspect" {
  project = google_project.platform_control.project_id
  name    = "connector-events-${var.environment}-harvest-dlq-inspect"
  topic   = google_pubsub_topic.harvest_dlq.name

  # Never expire — operator pulls manually when the DLQ alert fires.
  expiration_policy {
    ttl = ""
  }
  # Don't ack automatically; leave messages in the subscription until
  # ops explicitly acks them after investigation.
  ack_deadline_seconds = 600

  message_retention_duration = "604800s" # 7 days
}

# Grant harvest-service SA subscriber access on the DLQ inspect subscription
# so ops can drain it programmatically if needed.
resource "google_pubsub_subscription_iam_member" "harvest_dlq_inspect_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.harvest_dlq_inspect.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.harvest_service.email}"
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "project_id" {
  value = google_project.platform_control.project_id
}

output "project_number" {
  value = google_project.platform_control.number
}

output "cloud_sql_connection_name" {
  value = google_sql_database_instance.control_plane.connection_name
}

output "cloud_sql_private_ip" {
  value     = google_sql_database_instance.control_plane.private_ip_address
  sensitive = true
}

output "vpc_id" {
  value = google_compute_network.main.id
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/${google_artifact_registry_repository.platform.repository_id}"
}

output "platform_backend_sa" {
  description = "Platform Backend service account email"
  value       = google_service_account.platform_backend.email
}

output "service_accounts" {
  value = {
    platform_backend   = google_service_account.platform_backend.email
    pubsub_publisher   = google_service_account.pubsub_publisher.email
    cloud_tasks        = google_service_account.cloud_tasks.email
    tenant_provisioner = google_service_account.tenant_provisioner.email
    cloud_build        = google_service_account.cloud_build.email
    scheduler          = google_service_account.scheduler.email
  }
}

output "pubsub_topics" {
  value = { for k, v in google_pubsub_topic.control_plane : k => v.id }
}

output "db_secret_id" {
  value = google_secret_manager_secret.db_connection.secret_id
}

output "platform_backend_url" {
  description = "Platform Backend public URL (the load balancer hostname). Every consumer of this output is a caller in another project (the tenant sandbox push subscription, the governance eval job in platform-ci), and platform-backend's ingress admits such callers only through the load balancer."
  value       = local.platform_backend_public_url
}

output "platform_backend_name" {
  description = "Platform Backend Cloud Run service name"
  value       = module.platform_backend.service_name
}

# Connector Service outputs — consumed by tenant-runtime-template so
# per-tenant Cloud Run invoker IAM can reference the actual SA / URL
# once the service comes online.

output "connector_service_enabled" {
  description = "Whether the Connector Service Cloud Run resource exists."
  value       = module.connector_service.enabled
}

output "connector_service_sa_email" {
  description = "Connector Service SA email (always populated, even when enabled=false)."
  value       = module.connector_service.service_account_email
}

output "connector_service_url" {
  description = "Connector Service Cloud Run URL, or empty string when not yet deployed."
  value       = module.connector_service.service_url
}

# Governance Engine outputs — consumed by tenant-runtime-template so
# per-tenant Cloud Run invoker IAM can reference the actual SA / URL
# once the service comes online.

output "governance_engine_enabled" {
  description = "Whether the Governance Engine Cloud Run resource exists."
  value       = module.governance_engine.enabled
}

output "governance_engine_sa_email" {
  description = "Governance Engine SA email (always populated, even when enabled=false)."
  value       = module.governance_engine.service_account_email
}

output "governance_engine_url" {
  description = "Governance Engine Cloud Run URL, or empty string when not yet deployed."
  value       = module.governance_engine.service_url
}

output "governance_engine_project_id" {
  description = "GCP project hosting the Governance Engine."
  value       = module.governance_engine.project_id
}

# Harvest Service outputs — consumed by tenant-runtime-template so per-tenant
# Cloud Run invoker IAM can grant harvest-service the right to write memories
# back to the tenant's split services.

output "harvest_service_sa" {
  description = "Harvest Service SA email (always populated, even when enabled=false)."
  value       = google_service_account.harvest_service.email
}

output "harvest_service_enabled" {
  description = "Whether the Harvest Service Cloud Run resource exists."
  value       = var.harvest_service_enabled == true
}

output "harvest_service_url" {
  description = "Harvest Service Cloud Run URL, or empty string when not yet deployed."
  value       = var.harvest_service_enabled == true ? google_cloud_run_v2_service.harvest_service[0].uri : ""
}

output "governance_events_topic" {
  description = "Name of the multiplexed governance events Pub/Sub topic (kill-switch-changed and future events share this topic, disambiguated by the `eventType` message attribute)."
  value       = google_pubsub_topic.governance_events.name
}

# =============================================================================
# Phase 0 — platform-backend decomposition: billing / developer-proxy /
# workforce-service
# =============================================================================

# ── Enablement flags (default false so plumbing lands ahead of first image) ──

variable "billing_enabled" {
  type    = bool
  default = false
}

variable "billing_image_sha" {
  type = string
  # TODO: image SHA when liftoff-billing first builds.
  default = "placeholder"
}

variable "stripe_ou_price_id" {
  description = "Stripe Price ID for the operating_unit_consumed meter item."
  type        = string
  default     = ""
}

# Self-serve plan persistent price IDs — one per (plan, billing period).
# Set per environment in `environments/<env>/terraform.tfvars`. Empty means
# the billing service will return `plan_price_not_configured` for that plan
# rather than subscribing customers under the wrong product.
variable "stripe_plan_core_monthly_price_id" {
  type    = string
  default = ""
}
variable "stripe_plan_core_annual_price_id" {
  type    = string
  default = ""
}
variable "stripe_plan_growth_monthly_price_id" {
  type    = string
  default = ""
}
variable "stripe_plan_growth_annual_price_id" {
  type    = string
  default = ""
}
variable "stripe_plan_scale_monthly_price_id" {
  type    = string
  default = ""
}
variable "stripe_plan_scale_annual_price_id" {
  type    = string
  default = ""
}

variable "developer_proxy_enabled" {
  type    = bool
  default = false
}

variable "developer_proxy_image_sha" {
  type = string
  # TODO: image SHA when liftoff-developer-proxy first builds.
  default = "placeholder"
}

variable "workforce_enabled" {
  type    = bool
  default = false
}

variable "workforce_image_sha" {
  type = string
  # TODO: image SHA when liftoff-workforce-service first builds.
  default = "placeholder"
}

variable "workforce_cloud_build_trigger_enabled" {
  description = "Create the Cloud Build trigger for liftoff-workforce-service. Set true once the GitHub App connection is confirmed in the control project."
  type        = bool
  default     = false
}

variable "read_replica_enabled" {
  description = "Create the control-plane-pg read replica for billing reconciliation (plan 0d)."
  type        = bool
  default     = false
}

variable "pgbouncer_enabled" {
  description = "Create the shared PgBouncer MIG in front of control-plane-pg (plan 0d)."
  type        = bool
  default     = false
}

variable "audit_anchor_operator_readers" {
  description = "IAM members (group:/user:) granted read-only on audit-anchors bucket (plan 0y)."
  type        = list(string)
  default     = []
}

variable "bigquery_sink_governance_mirror" {
  type    = bool
  default = false
}

variable "bigquery_sink_enable_dataflow" {
  type        = bool
  default     = false
  description = "Provision the Dataflow streaming job (developer-proxy-usage → BQ). Disable in dev to avoid Dataflow API requirement in the CI project."
}

variable "platform_backend_public_url" {
  type        = string
  default     = ""
  description = <<-EOT
    Static URL for platform-backend used as PLATFORM_BACKEND_URL on billing.
    Passed as a string (not module.platform_backend.service_uri) to break the
    cycle: PB.env_vars already references billing.service_url, so making
    billing reference module.platform_backend.service_uri closes the loop.
    Use the custom domain in prod (https://api.example.com) and the
    direct Cloud Run URL in dev.
  EOT
}

# ── Per-service DB passwords ────────────────────────────────────────────────

resource "random_password" "billing_app" {
  length  = 32
  special = false
}
resource "random_password" "billing_migrate" {
  length  = 32
  special = false
}
resource "random_password" "billing_readonly" {
  length  = 32
  special = false
}

resource "random_password" "developer_proxy_app" {
  length  = 32
  special = false
}
resource "random_password" "developer_proxy_migrate" {
  length  = 32
  special = false
}
resource "random_password" "developer_proxy_readonly" {
  length  = 32
  special = false
}

resource "random_password" "workforce_app" {
  length  = 32
  special = false
}
resource "random_password" "workforce_migrate" {
  length  = 32
  special = false
}
resource "random_password" "workforce_readonly" {
  length  = 32
  special = false
}

# ── Per-service *-pg-password secrets (sourced into the services) ───────────

resource "google_secret_manager_secret" "billing_pg_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "billing-pg-password"

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

resource "google_secret_manager_secret_version" "billing_pg_password" {
  secret      = google_secret_manager_secret.billing_pg_password.id
  secret_data = random_password.billing_app.result
}

resource "google_secret_manager_secret" "developer_proxy_pg_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "developer-proxy-pg-password"

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

resource "google_secret_manager_secret_version" "developer_proxy_pg_password" {
  secret      = google_secret_manager_secret.developer_proxy_pg_password.id
  secret_data = random_password.developer_proxy_app.result
}

resource "google_secret_manager_secret" "workforce_pg_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "workforce-pg-password"

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

resource "google_secret_manager_secret_version" "workforce_pg_password" {
  secret      = google_secret_manager_secret.workforce_pg_password.id
  secret_data = random_password.workforce_app.result
}

resource "google_secret_manager_secret" "workforce_pg_migrate_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "workforce-pg-migrate-password"

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

resource "google_secret_manager_secret_version" "workforce_pg_migrate_password" {
  secret      = google_secret_manager_secret.workforce_pg_migrate_password.id
  secret_data = random_password.workforce_migrate.result
}

resource "google_secret_manager_secret" "billing_pg_migrate_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "billing-pg-migrate-password"

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

resource "google_secret_manager_secret_version" "billing_pg_migrate_password" {
  secret      = google_secret_manager_secret.billing_pg_migrate_password.id
  secret_data = random_password.billing_migrate.result
}

resource "google_secret_manager_secret" "developer_proxy_pg_migrate_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "developer-proxy-pg-migrate-password"

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

resource "google_secret_manager_secret_version" "developer_proxy_pg_migrate_password" {
  secret      = google_secret_manager_secret.developer_proxy_pg_migrate_password.id
  secret_data = random_password.developer_proxy_migrate.result
}

# ── Read replica (plan 0d) ───────────────────────────────────────────────────

module "read_replica" {
  count  = var.read_replica_enabled ? 1 : 0
  source = "../../modules/read-replica"

  project_id           = google_project.platform_control.project_id
  environment          = var.environment
  region               = var.region
  master_instance_name = google_sql_database_instance.control_plane.name
  network_id           = google_compute_network.main.id
  db_tier              = var.environment == "prod" ? "db-custom-4-8192" : "db-custom-2-4096"
}

# ── Pub/Sub topics owned by the four new producers (plan 0w) ─────────────────

module "billing_pubsub" {
  source = "../../modules/pubsub-events"

  project_id  = google_project.platform_control.project_id
  environment = var.environment

  topics = {
    billing-events = {
      ordering      = true
      retention     = "604800s"
      dlq_retention = "604800s"
    }
  }

  publisher_sa_emails = {
    billing-events = module.billing.service_account_email
  }
}

module "workforce_pubsub" {
  source = "../../modules/pubsub-events"

  project_id  = google_project.platform_control.project_id
  environment = var.environment

  topics = {
    workforce-events = {
      ordering      = true
      retention     = "604800s"
      dlq_retention = "604800s"
    }
  }

  publisher_sa_emails = {
    workforce-events = module.workforce_service.service_account_email
  }
}

module "developer_proxy_pubsub" {
  source = "../../modules/pubsub-events"

  project_id  = google_project.platform_control.project_id
  environment = var.environment

  topics = {
    developer-proxy-usage = {
      ordering      = false
      retention     = "604800s"
      dlq_retention = "604800s"
    }
  }

  publisher_sa_emails = {
    developer-proxy-usage = module.developer_proxy.service_account_email
  }
}

# ── Billing ──────────────────────────────────────────────────────────────────

module "billing" {
  source = "../../modules/billing"

  project_id                        = google_project.platform_control.project_id
  environment                       = var.environment
  region                            = var.region
  billing_account                   = var.billing_account
  control_plane_sql_instance        = google_sql_database_instance.control_plane.name
  control_plane_sql_connection_name = google_sql_database_instance.control_plane.connection_name
  kms_key_ring_id                   = google_kms_key_ring.main.id
  network_id                        = google_compute_network.main.id
  vpc_network_id                    = google_compute_network.main.id
  vpc_subnetwork_id                 = google_compute_subnetwork.main.id
  platform_backend_sa_email         = google_service_account.platform_backend.email
  platform_backend_url              = var.platform_backend_public_url

  image_sha = var.billing_image_sha
  enabled   = var.billing_enabled

  stripe_ou_price_id = var.stripe_ou_price_id

  stripe_plan_core_monthly_price_id   = var.stripe_plan_core_monthly_price_id
  stripe_plan_core_annual_price_id    = var.stripe_plan_core_annual_price_id
  stripe_plan_growth_monthly_price_id = var.stripe_plan_growth_monthly_price_id
  stripe_plan_growth_annual_price_id  = var.stripe_plan_growth_annual_price_id
  stripe_plan_scale_monthly_price_id  = var.stripe_plan_scale_monthly_price_id
  stripe_plan_scale_annual_price_id   = var.stripe_plan_scale_annual_price_id

  billing_events_dlq_topic_id = "projects/${google_project.platform_control.project_id}/topics/${module.billing_pubsub.dlq_topics["billing-events"]}"

  db_app_password      = random_password.billing_app.result
  db_migrate_password  = random_password.billing_migrate.result
  db_readonly_password = random_password.billing_readonly.result

  # Scheduler auth wiring for the billing module's Cloud Scheduler jobs
  # (card-expiring, test-subscription-refresh, subscription-reconciliation).
  #
  # MUST come from the secret's CURRENT version, not
  # random_password.billing_service_token.result: the secret version has
  # ignore_changes on secret_data, so after an out-of-band rotation the
  # random_password state keeps the ORIGINAL value while the billing service
  # reads the rotated one — every scheduler then 401s silently.
  billing_service_token           = data.google_secret_manager_secret_version.billing_service_token_current.secret_data
  scheduler_service_account_email = google_service_account.scheduler.email

  depends_on = [google_project_service.apis]
}

# ── Developer Proxy ──────────────────────────────────────────────────────────

module "developer_proxy" {
  source = "../../modules/developer-proxy"

  project_id                        = google_project.platform_control.project_id
  environment                       = var.environment
  region                            = var.region
  billing_account                   = var.billing_account
  control_plane_sql_instance        = google_sql_database_instance.control_plane.name
  control_plane_sql_connection_name = google_sql_database_instance.control_plane.connection_name
  kms_key_ring_id                   = google_kms_key_ring.main.id
  network_id                        = google_compute_network.main.id
  vpc_network_id                    = google_compute_network.main.id
  vpc_subnetwork_id                 = google_compute_subnetwork.main.id
  platform_backend_sa_email         = google_service_account.platform_backend.email

  image_sha = var.developer_proxy_image_sha
  enabled   = var.developer_proxy_enabled

  billing_service_url = module.billing.service_url

  db_app_password      = random_password.developer_proxy_app.result
  db_migrate_password  = random_password.developer_proxy_migrate.result
  db_readonly_password = random_password.developer_proxy_readonly.result

  depends_on = [google_project_service.apis]
}

# ── Workforce Service ────────────────────────────────────────────────────────

module "workforce_service" {
  source = "../../modules/workforce-service"

  resume_stuck_plans_schedule = var.idle_cadence ? local.idle_schedule : "*/15 * * * *"

  project_id                        = google_project.platform_control.project_id
  environment                       = var.environment
  region                            = var.region
  billing_account                   = var.billing_account
  control_plane_sql_instance        = google_sql_database_instance.control_plane.name
  control_plane_sql_connection_name = google_sql_database_instance.control_plane.connection_name
  kms_key_ring_id                   = google_kms_key_ring.main.id
  network_id                        = google_compute_network.main.id
  vpc_network_id                    = google_compute_network.main.id
  vpc_subnetwork_id                 = google_compute_subnetwork.main.id
  platform_backend_sa_email         = google_service_account.platform_backend.email

  image_sha = var.workforce_image_sha
  enabled   = var.workforce_enabled

  cloud_build_trigger_enabled = var.workforce_cloud_build_trigger_enabled

  db_app_password      = random_password.workforce_app.result
  db_migrate_password  = random_password.workforce_migrate.result
  db_readonly_password = random_password.workforce_readonly.result

  depends_on = [google_project_service.apis]
}

# ── PgBouncer (shared) ───────────────────────────────────────────────────────
# Needs its own SA + a subnetwork; wired with placeholders so the module is
# instantiated and shows up in plan output. Flip pgbouncer_enabled once the
# SA + subnetwork are provisioned.

resource "google_service_account" "pgbouncer" {
  count        = var.pgbouncer_enabled ? 1 : 0
  project      = google_project.platform_control.project_id
  account_id   = "pgbouncer-${var.environment}"
  display_name = "PgBouncer — ${var.environment}"
}

module "pgbouncer" {
  count  = var.pgbouncer_enabled ? 1 : 0
  source = "../../modules/pgbouncer"

  project_id                        = google_project.platform_control.project_id
  environment                       = var.environment
  region                            = var.region
  network_id                        = google_compute_network.main.id
  subnetwork_id                     = google_compute_subnetwork.main.id
  control_plane_sql_private_ip      = google_sql_database_instance.control_plane.private_ip_address
  control_plane_sql_max_connections = var.environment == "prod" ? 400 : 200
  service_quotas = var.environment == "prod" ? {
    platform-backend = 160
    connector        = 60
    governance       = 60
    billing          = 40
    developer-proxy  = 40
    workforce        = 40
    } : {
    platform-backend = 80
    connector        = 30
    governance       = 30
    billing          = 20
    developer-proxy  = 20
    workforce        = 20
  }
  kms_key_id         = google_kms_crypto_key.database.id
  pgbouncer_sa_email = google_service_account.pgbouncer[0].email
}

# ── Audit anchor bucket (plan 0y) ───────────────────────────────────────────

module "audit_anchor" {
  source = "../../modules/audit-anchor"

  project_id      = google_project.platform_control.project_id
  environment     = var.environment
  region          = var.region
  kms_key_ring_id = google_kms_key_ring.main.id

  anchor_service_accounts = {
    billing         = module.billing.service_account_email
    workforce       = module.workforce_service.service_account_email
    governance      = module.governance_engine.service_account_email
    developer-proxy = module.developer_proxy.service_account_email
    connector       = module.connector_service.service_account_email
  }

  gcs_sa_email       = data.google_storage_project_service_account.gcs_sa.email_address
  operator_readers   = var.audit_anchor_operator_readers
  scheduler_sa_email = google_service_account.scheduler.email
  anchor_job_urls = {
    billing         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/billing-audit-anchor-${var.environment}:run"
    workforce       = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/workforce-audit-anchor-${var.environment}:run"
    governance      = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/governance-engine-audit-anchor-${var.environment}:run"
    developer-proxy = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/developer-proxy-audit-anchor-${var.environment}:run"
    # connector-service has no anchor: its database holds no partitioned table
    # and no audit log. Add it back the day it gains one.
  }
  enable_scheduler = true

  depends_on = [google_project_service.apis]
}

# ── Data-subject-access orchestrator (plan 0s) ──────────────────────────────

resource "google_service_account" "data_export_orchestrator" {
  project      = google_project.platform_control.project_id
  account_id   = "dsar-orchestrator-${var.environment}"
  display_name = "Data-Subject Access Orchestrator — ${var.environment}"
  description  = "Fans out ExportTenantData + DeleteTenantUserData per plan 0s."
}

module "data_export_orchestrator" {
  source = "../../modules/data-export-orchestrator"

  project_id            = google_project.platform_control.project_id
  environment           = var.environment
  region                = var.region
  image_repo            = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/YOUR_GCP_PROJECT${var.environment}"
  image_sha             = var.platform_backend_image_sha
  kms_key_id            = google_kms_crypto_key.database.id
  service_account_email = google_service_account.data_export_orchestrator.email

  depends_on = [
    google_kms_crypto_key_iam_member.secretmanager_database_key,
    google_kms_crypto_key_iam_member.gcs_database_key,
  ]
}

# ── BigQuery sink (plan 0m) ─────────────────────────────────────────────────

resource "google_service_account" "bigquery_dataflow" {
  project      = google_project.platform_control.project_id
  account_id   = "bq-dataflow-${var.environment}"
  display_name = "BigQuery Dataflow streaming — ${var.environment}"
}

module "bigquery_sink" {
  source = "../../modules/bigquery-sink"

  project_id                  = google_project.platform_control.project_id
  environment                 = var.environment
  region                      = var.region
  developer_proxy_usage_topic = module.developer_proxy_pubsub.topics["developer-proxy-usage"]
  dataflow_service_account    = google_service_account.bigquery_dataflow.email
  kms_key_id                  = google_kms_crypto_key.database.id

  enable_governance_audit_mirror   = var.bigquery_sink_governance_mirror
  enable_dataflow_job              = var.bigquery_sink_enable_dataflow
  governance_audit_topic           = google_pubsub_topic.governance_events.name
  enable_gcp_billing_export        = true
  platform_backend_service_account = google_service_account.platform_backend.email

  depends_on = [
    google_project_service.apis,
    google_kms_crypto_key_iam_member.bigquery_database_key,
  ]
}

# ── Outputs ─────────────────────────────────────────────────────────────────

output "billing_sa_email" {
  value = module.billing.service_account_email
}

output "billing_url" {
  value = module.billing.service_url
}

output "billing_stripe_webhook_url" {
  value = module.billing.stripe_webhook_url
}

output "developer_proxy_sa_email" {
  value = module.developer_proxy.service_account_email
}

output "developer_proxy_url" {
  value = module.developer_proxy.service_url
}

# ── Audit events: governance-engine → platform-backend ──────────────────

resource "google_pubsub_topic" "audit_events" {
  project = google_project.platform_control.project_id
  name    = "audit-events-${var.environment}"

  message_retention_duration = "604800s" # 7 days

  depends_on = [google_project_service.apis]

  labels = {
    managed-by  = "terraform"
    service     = "governance-engine"
    environment = var.environment
  }
}

resource "google_pubsub_topic" "audit_events_dlq" {
  project = google_project.platform_control.project_id
  name    = "audit-events-${var.environment}-dlq"

  message_retention_duration = "1209600s" # 14 days

  depends_on = [google_project_service.apis]

  labels = {
    managed-by  = "terraform"
    service     = "governance-engine"
    environment = var.environment
    role        = "dead-letter"
  }
}

# -----------------------------------------------------------------------------
# Phase 1 of unified workspace audit log: platform-backend's pull subscription
# on the shared control-plane-events topic.
#
# `startEventSubscribers` in src/events/subscriber.ts boots a pull subscriber
# on `control-plane-events-{env}-sub`, dispatching:
#   - connector.credentials_stored → pending_integrations resolution
#   - connector.deleted             → tenant-runtime content/webhook cleanup
#   - audit.platform_event          → cross-service audit bridge
#                                     (consumed from liftoff-connector-service
#                                     and liftoff-billing)
#
# Without this subscription the subscriber logs a NOT_FOUND warning on boot
# and silently swallows the messages.
# -----------------------------------------------------------------------------
resource "google_pubsub_subscription" "control_plane_events_platform_backend" {
  project = google_project.platform_control.project_id
  name    = "control-plane-events-${var.environment}-sub"
  topic   = google_pubsub_topic.control_plane["control-plane-events"].id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s" # 7 days
  retain_acked_messages      = false

  expiration_policy {
    ttl = "" # never expire
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

resource "google_pubsub_subscription_iam_member" "platform_backend_control_plane_subscriber" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.control_plane_events_platform_backend.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Pub/Sub service agent must be able to publish to the generic dead-letter
# topic for dead_letter_policy to actually route failed messages — without
# this grant, the policy is configured but Pub/Sub silently fails to forward
# poison messages (they pile up on the subscription instead). Mirrors the
# pattern in `harvest_control_plane_dlq_publisher` below.
#
# This grant benefits every subscription on the platform-control project
# that references `google_pubsub_topic.dead_letter.id` as its DLQ, not just
# the platform-backend control-plane subscription.
resource "google_pubsub_topic_iam_member" "dead_letter_pubsub_service_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.dead_letter.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription" "audit_events_platform_backend" {
  project = google_project.platform_control.project_id
  name    = "audit-events-${var.environment}-platform-backend-sub"
  topic   = google_pubsub_topic.audit_events.id

  ack_deadline_seconds       = 60
  retain_acked_messages      = false
  message_retention_duration = "604800s"

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.audit_events_dlq.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_subscription" "audit_events_dlq_drain" {
  project = google_project.platform_control.project_id
  name    = "audit-events-${var.environment}-dlq-drain"
  topic   = google_pubsub_topic.audit_events_dlq.id

  ack_deadline_seconds       = 600
  message_retention_duration = "1209600s"

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_topic_iam_member" "governance_engine_audit_publish" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.audit_events.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:governance-engine-${var.environment}@YOUR_GCP_PROJECT${var.environment}.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "platform_backend_audit_subscribe" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.audit_events_platform_backend.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_pubsub_subscription_iam_member" "platform_backend_audit_dlq_drain" {
  project      = google_project.platform_control.project_id
  subscription = google_pubsub_subscription.audit_events_dlq_drain.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_pubsub_topic_iam_member" "audit_events_dlq_pubsub_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.audit_events_dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_monitoring_alert_policy" "audit_events_dlq" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Audit Events DLQ has messages (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "audit-events DLQ backlog > 0"
    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" AND resource.label.subscription_id=\"audit-events-${var.environment}-dlq-drain\" AND metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "60s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.slack[0].name]

  documentation {
    content = "governance-engine failed to deliver audit events to platform-backend after 5 retries. Check governance-engine Pub/Sub publish logs and platform-backend audit-events subscriber logs."
  }
}

# -----------------------------------------------------------------------------
# Admin API (PR 0 — enterprise provisioning hardening)
# -----------------------------------------------------------------------------
#
# Three Cloud Logging metrics + alerts wired to admin-API hot paths:
#
#   1. admin_api_legacy_url_404 — fires when a request lands on a URL that
#      was retired in PR 0 (the platform-backend admin router emits an
#      admin.api.404_legacy_url log entry from its catch-all). Indicates a
#      stale runbook is in circulation.
#   2. billing_mirror_update_failed_dlq — fires when PR 2b's
#      billing.mirror.update_failed outbox event reaches max Pub/Sub
#      redelivery attempts. Pages oncall — the platform-backend subscription
#      mirror is out of sync with Stripe.
#   3. pb_mirror_retry_storm — high frequency of PR 2b's
#      stripe.consumer.pb_mirror_failed_will_retry events. Indicates the
#      platform-backend cancel endpoint is broadly unhealthy, not a single
#      bad event.

resource "google_logging_metric" "admin_api_legacy_url_404" {
  project = google_project.platform_control.project_id
  name    = "admin_api_legacy_url_404"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"platform-backend\" AND jsonPayload.msg=\"admin.api.404_legacy_url\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# GCP log-metric → alert-policy race: the user-metric type is created via the
# Logging API but takes up to ~60s to register in the Monitoring metric type
# registry. Without this gate the AlertPolicy create 404s with
#   "Cannot find metric(s) that match type =
#    logging.googleapis.com/user/<name>. If a metric was created recently, it
#    could take up to 10 minutes to become available. Please try again soon."
# on a cold-start apply. 60s is enough margin in
# practice; the cost is a one-time delay during cold-start applies.
resource "time_sleep" "wait_admin_api_legacy_url_404_metric" {
  depends_on      = [google_logging_metric.admin_api_legacy_url_404]
  create_duration = "60s"
}

resource "google_monitoring_alert_policy" "admin_api_legacy_url_404" {
  count = var.slack_bot_token != "" ? 1 : 0

  depends_on = [time_sleep.wait_admin_api_legacy_url_404_metric]

  project      = google_project.platform_control.project_id
  display_name = "Admin API: legacy URL 404s (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "admin.api.404_legacy_url events > 0 / 5 min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.admin_api_legacy_url_404.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = local.notification_channels

  documentation {
    content = "A retired admin URL (e.g. /api/admin/enterprise-contracts/:accountId, /api/admin/billing/accounts/:id/provision-enterprise) is being hit. Likely a stale runbook is in circulation — search recent commits to docs/runbooks/ and update the affected document. The current canonical reference is liftoff-platform-backend/docs/admin-api.md."
  }
}

resource "google_logging_metric" "billing_mirror_update_failed" {
  project = google_project.platform_control.project_id
  name    = "billing_mirror_update_failed_dlq"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"billing\" AND jsonPayload.event_type=\"billing.mirror.update_failed\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# See note above admin_api_legacy_url_404 — same propagation race. This pair
# DID fail on first apply because the alert policy was created within ~1s of
# the metric, well inside GCP's metric-type-registry propagation window.
resource "time_sleep" "wait_billing_mirror_update_failed_metric" {
  depends_on      = [google_logging_metric.billing_mirror_update_failed]
  create_duration = "60s"
}

resource "google_monitoring_alert_policy" "billing_mirror_update_failed_dlq" {
  count = var.slack_bot_token != "" ? 1 : 0

  depends_on = [time_sleep.wait_billing_mirror_update_failed_metric]

  project      = google_project.platform_control.project_id
  display_name = "Billing: mirror update failed (DLQ-bound) (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "billing.mirror.update_failed events > 0 / 5 min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.billing_mirror_update_failed.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = local.notification_channels

  documentation {
    content = "liftoff-billing failed to mirror a subscription cancellation to platform-backend after Pub/Sub max redelivery attempts. The platform-backend subscriptions table is now out of sync with Stripe for the customer in the event payload. Inspect the billing-events-${var.environment}-dlq subscription and the stripe.consumer.pb_mirror_failed_will_retry logs for the failure mode, then trigger a manual mirror update once the underlying issue is resolved."
  }
}

resource "google_logging_metric" "pb_mirror_retry_storm" {
  project = google_project.platform_control.project_id
  name    = "pb_mirror_retry_storm"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"billing\" AND jsonPayload.msg=\"stripe.consumer.pb_mirror_failed_will_retry\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

# See note above admin_api_legacy_url_404 — same propagation race. This pair
# also failed on first apply.
resource "time_sleep" "wait_pb_mirror_retry_storm_metric" {
  depends_on      = [google_logging_metric.pb_mirror_retry_storm]
  create_duration = "60s"
}

resource "google_monitoring_alert_policy" "pb_mirror_retry_storm" {
  count = var.slack_bot_token != "" ? 1 : 0

  depends_on = [time_sleep.wait_pb_mirror_retry_storm_metric]

  project      = google_project.platform_control.project_id
  display_name = "Billing: PB mirror retry storm (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "pb_mirror_failed_will_retry rate > 10/min for 5 min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.pb_mirror_retry_storm.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }

  notification_channels = local.notification_channels

  documentation {
    content = "Sustained high rate of platform-backend mirror retries. Indicates the PB /api/internal/billing/controls/:id/subscription-cancelled endpoint is broadly unhealthy, not a single bad event. Check platform-backend Cloud Run health + recent deploys."
  }
}

output "workforce_sa_email" {
  value = module.workforce_service.service_account_email
}

output "workforce_url" {
  value = module.workforce_service.service_url
}

output "audit_anchor_bucket" {
  value = module.audit_anchor.bucket_name
}

output "developer_proxy_usage_bq_dataset" {
  value = module.bigquery_sink.developer_proxy_usage_dataset_id
}

