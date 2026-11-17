# IAM Module
# Per Section 18: Least-privilege IAM, tenant-scoped service accounts

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "tenant_id" {
  description = "Tenant ID for tenant-scoped service accounts"
  type        = string
  default     = ""
}

variable "cloud_sql_instance" {
  description = "Cloud SQL instance connection name"
  type        = string
  default     = ""
}

variable "kms_key_id" {
  description = "KMS key ID for encryption"
  type        = string
  default     = ""
}

variable "pubsub_topics" {
  description = "List of Pub/Sub topic names this module should have access to"
  type        = list(string)
  default     = []
}

variable "cloud_tasks_queues" {
  description = "List of Cloud Tasks queue names"
  type        = list(string)
  default     = []
}

variable "storage_buckets" {
  description = "List of storage bucket names"
  type        = list(string)
  default     = []
}

# ==========================================
# Control Plane Service Accounts
# ==========================================

resource "google_service_account" "control_plane" {
  count = var.tenant_id == "" ? 1 : 0

  project      = var.project_id
  account_id   = "control-plane-${var.environment}"
  display_name = "Control Plane Service Account"
  description  = "Service account for control plane operations"
}

# Control plane needs access to:
# - Cloud SQL (read/write platform data)
# - Pub/Sub (publish events)
# - Secret Manager (read secrets)
# - Cloud Tasks (enqueue tasks)
# - Cloud Trace (write traces)

resource "google_project_iam_member" "control_plane_cloudsql" {
  count = var.tenant_id == "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.control_plane[0].email}"
}

resource "google_project_iam_member" "control_plane_pubsub_publisher" {
  count = var.tenant_id == "" ? 1 : 0

  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.control_plane[0].email}"
}

resource "google_project_iam_member" "control_plane_secrets" {
  count = var.tenant_id == "" ? 1 : 0

  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.control_plane[0].email}"
}

resource "google_project_iam_member" "control_plane_tasks" {
  count = var.tenant_id == "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.control_plane[0].email}"
}

resource "google_project_iam_member" "control_plane_trace" {
  count = var.tenant_id == "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.control_plane[0].email}"
}

resource "google_project_iam_member" "control_plane_logging" {
  count = var.tenant_id == "" ? 1 : 0

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.control_plane[0].email}"
}

resource "google_project_iam_member" "control_plane_monitoring" {
  count = var.tenant_id == "" ? 1 : 0

  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.control_plane[0].email}"
}

# KMS access for encryption
resource "google_kms_crypto_key_iam_member" "control_plane_kms" {
  count = var.tenant_id == "" && var.kms_key_id != "" ? 1 : 0

  crypto_key_id = var.kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.control_plane[0].email}"
}

# ==========================================
# Tenant Runtime Service Accounts
# ==========================================

# Main tenant runtime service account
resource "google_service_account" "tenant_runtime" {
  count = var.tenant_id != "" ? 1 : 0

  project      = var.project_id
  account_id   = "tenant-${var.tenant_id}-runtime"
  display_name = "Tenant ${var.tenant_id} Runtime"
  description  = "Main runtime service account for tenant ${var.tenant_id}"
}

# Coordinator service account (high privilege for workflow orchestration)
resource "google_service_account" "coordinator" {
  count = var.tenant_id != "" ? 1 : 0

  project      = var.project_id
  account_id   = "tenant-${var.tenant_id}-coord"
  display_name = "Coordinator - Tenant ${var.tenant_id}"
  description  = "Coordinator service account for workflow orchestration"
}

# Tool gateway service account (external system access)
resource "google_service_account" "tool_gateway" {
  count = var.tenant_id != "" ? 1 : 0

  project      = var.project_id
  account_id   = "tenant-${var.tenant_id}-tg"
  display_name = "Tool Gateway - Tenant ${var.tenant_id}"
  description  = "Tool gateway service account for external system access"
}

# Action ledger service account
resource "google_service_account" "action_ledger" {
  count = var.tenant_id != "" ? 1 : 0

  project      = var.project_id
  account_id   = "tenant-${var.tenant_id}-ledger"
  display_name = "Action Ledger - Tenant ${var.tenant_id}"
  description  = "Action ledger service account for audit trail"
}

# Reflection engine service account (lower priority)
resource "google_service_account" "reflection" {
  count = var.tenant_id != "" ? 1 : 0

  project      = var.project_id
  account_id   = "tenant-${var.tenant_id}-reflect"
  display_name = "Reflection Engine - Tenant ${var.tenant_id}"
  description  = "Reflection engine service account"
}

# ==========================================
# Tenant Runtime IAM Bindings
# ==========================================

# Tenant runtime - Cloud SQL access
resource "google_project_iam_member" "tenant_runtime_cloudsql" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# Tenant runtime - Pub/Sub subscriber (receive control plane events)
resource "google_project_iam_member" "tenant_runtime_pubsub_subscriber" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# Tenant runtime - Pub/Sub publisher (emit workflow events)
resource "google_project_iam_member" "tenant_runtime_pubsub_publisher" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# Tenant runtime - Secret Manager READ (connector credentials, OAuth tokens)
resource "google_project_iam_member" "tenant_runtime_secrets" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# Tenant runtime - Secret Manager: READ ONLY, deliberately.
#
# Agent-authored code executes in this service account's container, so every
# role granted here is a role an agent can reach. The runtime reads connector
# credentials and API keys; it writes none, and secret creation belongs to the
# platform backend.
#
# Grant write again only if the runtime takes back inline OAuth refresh, and
# know the symptom of getting it wrong: reads keep working, so nothing fails
# until each connector's access token first expires.

# Tenant runtime - Cloud Scheduler admin (manage per-agent scheduler jobs)
# Required for resumeJob/pauseJob/createOrUnpauseJob/deleteJob calls in
# src/scheduling/cloud-scheduler.ts. Without this, agent activation cannot
# resume the cron job and the agent never fires.
resource "google_project_iam_member" "tenant_runtime_scheduler_admin" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudscheduler.admin"
  member  = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# Tenant runtime - Cloud Tasks
resource "google_project_iam_member" "tenant_runtime_tasks" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# Tenant runtime - Cloud Trace
resource "google_project_iam_member" "tenant_runtime_trace" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# Tenant runtime - Logging
resource "google_project_iam_member" "tenant_runtime_logging" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# Tenant runtime - Monitoring
resource "google_project_iam_member" "tenant_runtime_monitoring" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# Tenant runtime - Vertex AI (memory embedding generation)
resource "google_project_iam_member" "tenant_runtime_vertex" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# ==========================================
# Coordinator IAM Bindings (High Priority)
# ==========================================

resource "google_project_iam_member" "coordinator_cloudsql" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.coordinator[0].email}"
}

resource "google_project_iam_member" "coordinator_tasks" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.coordinator[0].email}"
}

resource "google_project_iam_member" "coordinator_tasks_admin" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudtasks.taskDeleter"
  member  = "serviceAccount:${google_service_account.coordinator[0].email}"
}

resource "google_project_iam_member" "coordinator_pubsub" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.coordinator[0].email}"
}

# ==========================================
# Tool Gateway IAM Bindings
# ==========================================

resource "google_project_iam_member" "tool_gateway_cloudsql" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.tool_gateway[0].email}"
}

resource "google_project_iam_member" "tool_gateway_secrets" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.tool_gateway[0].email}"
}

# Tool gateway needs storage access for payload archival
resource "google_project_iam_member" "tool_gateway_storage" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.tool_gateway[0].email}"
}

# ==========================================
# Action Ledger IAM Bindings
# ==========================================

resource "google_project_iam_member" "action_ledger_cloudsql" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.action_ledger[0].email}"
}

resource "google_project_iam_member" "action_ledger_storage" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.action_ledger[0].email}"
}

# ==========================================
# Reflection Engine IAM Bindings (Lower Priority)
# ==========================================

resource "google_project_iam_member" "reflection_cloudsql" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.reflection[0].email}"
}

# Reflection needs Vertex AI access for Claude
resource "google_project_iam_member" "reflection_vertex" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.reflection[0].email}"
}

# ==========================================
# Storage Bucket IAM (if buckets provided)
# ==========================================

resource "google_storage_bucket_iam_member" "tenant_storage_admin" {
  for_each = var.tenant_id != "" ? toset(var.storage_buckets) : toset([])

  bucket = each.value
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.tenant_runtime[0].email}"
}

# ==========================================
# Outputs
# ==========================================

output "control_plane_sa" {
  description = "Control plane service account email"
  value       = var.tenant_id == "" ? google_service_account.control_plane[0].email : null
}

output "tenant_runtime_sa" {
  description = "Tenant runtime service account email"
  value       = var.tenant_id != "" ? google_service_account.tenant_runtime[0].email : null
}

output "coordinator_sa" {
  description = "Coordinator service account email"
  value       = var.tenant_id != "" ? google_service_account.coordinator[0].email : null
}

output "tool_gateway_sa" {
  description = "Tool gateway service account email"
  value       = var.tenant_id != "" ? google_service_account.tool_gateway[0].email : null
}

output "action_ledger_sa" {
  description = "Action ledger service account email"
  value       = var.tenant_id != "" ? google_service_account.action_ledger[0].email : null
}

output "reflection_sa" {
  description = "Reflection engine service account email"
  value       = var.tenant_id != "" ? google_service_account.reflection[0].email : null
}

output "all_tenant_service_accounts" {
  description = "All tenant service account emails"
  value = var.tenant_id != "" ? {
    runtime       = google_service_account.tenant_runtime[0].email
    coordinator   = google_service_account.coordinator[0].email
    tool_gateway  = google_service_account.tool_gateway[0].email
    action_ledger = google_service_account.action_ledger[0].email
    reflection    = google_service_account.reflection[0].email
  } : {}
}
