# Staging Environment Configuration
# Per Section 2: GCP Layout
# Staging is the pre-production environment for validation testing

terraform {
  # `removed` block (used in tenant-runtime-template/agent_creation_resilience.tf)
  # requires Terraform >= 1.7.
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.25, < 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 5.25, < 6.0"
    }
    # `time_sleep` in tenant-runtime-template/pubsub_push.tf gates the IAM-
    # propagation pause between push-SA token-creator grant and push sub
    # creation. Pinned for reproducible CI plans.
    time = {
      source  = "hashicorp/time"
      version = ">= 0.9"
    }
  }

  backend "gcs" {
    bucket = "YOUR_CI_PROJECT_staging-tfstate"
    prefix = "terraform/state"
  }
}

provider "google" {
  region = var.region
}

# Aliased provider pinned to the platform-control project. Used by the
# tenant-runtime-template module (pubsub_push.tf) when it creates the dedicated
# Pub/Sub push SA in YOUR_GCP_PROJECT.
provider "google" {
  alias   = "platform_control"
  region  = var.region
  project = "YOUR_GCP_PROJECT${var.environment}"
}

provider "google-beta" {
  region = var.region
}

# -----------------------------------------------------------------------------
# Variables
# -----------------------------------------------------------------------------

variable "org_id" {
  type        = string
  description = "GCP Organization ID"
}

variable "billing_account" {
  type        = string
  description = "Billing account ID"
}

variable "region" {
  type        = string
  default     = "us-west1"
  description = "Primary region for deployment"
}

variable "environment" {
  type        = string
  default     = "staging"
  description = "Environment name"
}

variable "github_repos_connected" {
  type        = bool
  default     = false
  description = "Set to true after GitHub repos are connected in Cloud Build console"
}

variable "slack_bot_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Slack Bot OAuth Token (xoxb-...) for #platform-observability-alerts"
}

variable "tenant_runtime_url" {
  type        = string
  default     = ""
  description = "Tenant Runtime Cloud Run service URL for cross-service API calls (set after tenant-runtime is deployed)"
}

# Alert notification configuration
variable "alert_email" {
  type        = string
  default     = ""
  description = "Email for alert notifications (defaults to alerts@example.com)"
}

variable "pagerduty_service_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "PagerDuty integration key for on-call escalation"
}

# Platform callback token — shared secret that Cloud Scheduler jobs send in
# the X-Service-Auth header when they invoke /api/internal/* endpoints on
# platform-backend. Read directly from Secret Manager (the canonical store)
# so the X-Service-Auth headers Terraform writes on every scheduler resource
# always match what platform-backend's _serviceAuth.ts validates against.
# Without this, `var.platform_callback_token` defaults to "" and every infra
# apply silently breaks notifications-hourly-tick + every maintenance
# scheduler job (expire-agent-messages, ou-meter-retry-drain, etc.) with 401s.
data "google_secret_manager_secret_version" "platform_callback_token" {
  secret  = "platform-callback-token"
  project = "YOUR_GCP_PROJECT${var.environment}"
}

# -----------------------------------------------------------------------------
# Platform Projects
# -----------------------------------------------------------------------------

module "platform_control" {
  source = "../../projects/platform-control"

  org_id                  = var.org_id
  billing_account         = var.billing_account
  environment             = var.environment
  region                  = var.region
  slack_bot_token         = var.slack_bot_token
  platform_callback_token = data.google_secret_manager_secret_version.platform_callback_token.secret_data
  tenant_runtime_url      = var.tenant_runtime_url
}

module "platform_ci" {
  source = "../../projects/platform-ci"

  org_id                      = var.org_id
  billing_account             = var.billing_account
  environment                 = var.environment
  region                      = var.region
  platform_control_project_id = module.platform_control.project_id
  artifact_registry           = module.platform_control.artifact_registry
  github_repos_connected      = var.github_repos_connected

  # Staging deploys only from a `staging` branch — keeps staging out of the
  # dev (main) → prod (release) hot path so it can hold promotion candidates.
  deploy_branch_pattern = "^staging$"
}

# NOTE: platform_observability and platform_security have been consolidated into
# platform_control to reduce project sprawl. Observability (logging, monitoring,
# tracing) and security (KMS, audit) resources are now provisioned within
# the platform-control project.

# -----------------------------------------------------------------------------
# Tenant Projects
# Operator-owned tenant used for staging validation
# -----------------------------------------------------------------------------

module "tenant_liftoffos" {
  source = "../../projects/tenant-runtime-template"

  providers = {
    google                  = google
    google-beta             = google-beta
    google.platform_control = google.platform_control
  }

  org_id                = var.org_id
  billing_account       = var.billing_account
  environment           = var.environment
  region                = var.region
  tenant_id             = "liftoffos"
  slack_bot_token       = var.slack_bot_token
  platform_backend_sa   = "platform-backend-${var.environment}@YOUR_GCP_PROJECT${var.environment}.iam.gserviceaccount.com"
  sandbox_sidecar_image = "us-west1-docker.pkg.dev/YOUR_GCP_PROJECT/YOUR_GCP_PROJECT/sandbox-sidecar:latest"
  framer_rotator_image  = "us-west1-docker.pkg.dev/YOUR_GCP_PROJECT/YOUR_GCP_PROJECT/framer-secret-rotate:latest"

  # staging has no agent-diagnostics job/SA — opt out of the default fleet-harvest invoker
  # grant so it does not reference a non-existent member and fail apply.
  diagnostics_harvest_enabled = false
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "platform_control_project" {
  value = module.platform_control.project_id
}

output "platform_ci_project" {
  value = module.platform_ci.project_id
}

output "tenant_liftoffos_project" {
  value       = module.tenant_liftoffos.project_id
  description = "LiftoffOS tenant project: YOUR_TENANT_PROJECT"
}

output "workload_identity_provider" {
  value       = module.platform_ci.workload_identity_provider
  description = "Workload Identity Provider for GitHub Actions"
}
