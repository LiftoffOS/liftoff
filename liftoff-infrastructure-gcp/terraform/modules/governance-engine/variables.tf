# governance-engine: variables
# Reusable module for the Governance Engine Cloud Run deployment.

variable "project_id" {
  description = "GCP project ID where the Governance Engine is deployed (typically YOUR_GCP_PROJECT)"
  type        = string
}

variable "region" {
  description = "GCP region for the Governance Engine and its Cloud SQL instance"
  type        = string
  default     = "us-west1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "image" {
  description = <<-EOT
    Container image URL for the Governance Engine.
    Example: us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT_STAGING/YOUR_ARTIFACT_REPO_STAGING/governance-engine:dev
    When enabled = false this variable is not used but must still be provided.
  EOT
  type        = string
  default     = "us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT_STAGING/YOUR_ARTIFACT_REPO_STAGING/governance-engine:dev"
}

variable "min_instances" {
  description = <<-EOT
    Minimum number of Cloud Run instances. Set to >= 1 to eliminate cold
    starts on the governance authorize/preflight path (plan §3e: p95 < 3ms).
  EOT
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Maximum number of Cloud Run instances for autoscaling"
  type        = number
  default     = 10
}

variable "platform_backend_sa_email" {
  description = <<-EOT
    Service account email of the Platform Backend. This SA is granted
    roles/run.invoker on the Governance Engine so the Platform Backend
    can call policy-management and ledger-read endpoints.
  EOT
  type        = string
}

variable "network_id" {
  description = "VPC network ID for Cloud SQL private IP connectivity. Defaults to the project default network."
  type        = string
  default     = ""
}


variable "db_tier" {
  description = "Cloud SQL instance machine tier for governance-pg"
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_max_connections" {
  description = "max_connections setting for the governance-pg Cloud SQL instance"
  type        = number
  default     = 200
}

variable "db_app_password" {
  description = <<-EOT
    Password for the governance_app SQL user. Passed in from the parent
    project configuration where it is sourced from a random_password +
    Secret Manager secret (governance-pg-password). Marked sensitive.
  EOT
  type        = string
  sensitive   = true
}

variable "enabled" {
  description = <<-EOT
    Feature flag: whether to create the Governance Engine Cloud Run resource
    and the platform-backend invoker IAM binding. Set to true when the
    Governance Engine repo exists and its first container image has been
    pushed to Artifact Registry. Defaults to false so the module can be
    wired into environments without triggering premature resource creation.

    IAM and SA resources (and the Cloud SQL instance) are always created.
    The SA is needed by governance-iam for per-tenant invoker grants ahead
    of the service going live; the DB must exist before the cloudbuild
    migrate job runs on the first image push.
  EOT
  type        = bool
  default     = false
}

variable "env_vars" {
  description = "Additional environment variables to pass to the Governance Engine container"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = <<-EOT
    Secret Manager secrets to mount as environment variables in the
    Governance Engine. Expected secrets:
      - GOVERNANCE_SERVICE_TOKEN (secret: governance-engine-token — the
        Secret Manager resource is still named governance-engine-token
        for historical reasons; the env var follows the plan convention)
      - GOVERNANCE_PREFLIGHT_SIGNING_KEY (governance-preflight-signing-key)
      - DB_PASSWORD (governance-pg-password)
  EOT
  type = list(object({
    name        = string
    secret_name = string
    version     = string
  }))
  default = []
}

variable "reconciliation_enabled" {
  description = <<-EOT
    Whether to provision the nightly reconciliation Cloud Run Job +
    Cloud Scheduler trigger. Gated separately from var.enabled so the
    job can roll out after the initial Cloud Run service lands. Has
    no effect when var.enabled = false (the job image is the same as
    the service image, so the service must exist first).

    The job runs `node dist/scripts/reconcile/reconcile-wal-vs-governance.js`
    (see liftoff-governance-engine/scripts/reconcile/) which diffs the
    tenant-runtime local WAL against governance-pg and reports drift.
  EOT
  type        = bool
  default     = true
}

variable "reconciliation_schedule" {
  description = <<-EOT
    Cron expression for the nightly reconciliation Cloud Scheduler job.
    Defaults to 06:00 UTC (off-peak for US west customers). Change with
    care: reconciliation is read-heavy against both databases, so
    scheduling against peak hours may starve the hot path.
  EOT
  type        = string
  default     = "0 6 * * *"
}

variable "reconciliation_time_zone" {
  description = "IANA time zone for the reconciliation schedule."
  type        = string
  default     = "UTC"
}

variable "partition_management_enabled" {
  description = <<-EOT
    Whether to provision the monthly partition-management Cloud Run Job +
    Cloud Scheduler trigger. Has no effect unless var.enabled = true (the
    job reuses the service image). Defaults true so partitions are kept
    current automatically once the service is live.

    The job runs `node dist/scripts/partitions/manage-partitions.js`
    (see liftoff-governance-engine/scripts/partitions/) which creates the
    upcoming months of partitions and drops partitions older than the
    retention horizon.
  EOT
  type        = bool
  default     = true
}

variable "partition_schedule" {
  description = <<-EOT
    Cron expression for the monthly partition-management Cloud Scheduler
    job. Defaults to 03:00 UTC on the 1st of each month (well before the
    month boundary creates new write pressure). The job is idempotent,
    so running more often than this is harmless — don't run less often
    than the retention / creation horizons, though.
  EOT
  type        = string
  default     = "0 3 1 * *"
}

variable "partition_time_zone" {
  description = "IANA time zone for the partition-management schedule."
  type        = string
  default     = "UTC"
}

variable "partition_future_months" {
  description = <<-EOT
    Number of forward months the partition job should keep provisioned
    beyond the current month. Defaults to 3 so a missed run still leaves
    several months of headroom before writes start failing.
  EOT
  type        = number
  default     = 3
}

variable "partition_retain_months" {
  description = <<-EOT
    Retention horizon, in months, for the oldest partition kept around.
    Partitions older than `now - partition_retain_months` are DETACHed
    and DROPped. Defaults to 18, matching migration 001's initial
    pre-create of 18 months.
  EOT
  type        = number
  default     = 18
}

variable "sql_connection_name" {
  description = "Cloud SQL connection name of the instance holding the governance_engine database (control-plane-pg)."
  type        = string
}

variable "vpc_network_id" {
  description = "VPC network for Direct VPC egress (replaces the Serverless VPC Access connector)."
  type        = string
}

variable "vpc_subnetwork_id" {
  description = "Subnetwork Cloud Run takes egress IPs from (Direct VPC egress)."
  type        = string
}
