# bigquery-sink: BigQuery datasets + Pub/Sub → Dataflow streaming scaffold
# (plan 0m).
#
# Provisions:
#   - developer_proxy_usage BigQuery dataset (required).
#   - Optional governance-audit mirror dataset (disabled by
#     default; flip on once compliance analytics need it).
#   - Pub/Sub push subscription from developer-proxy-usage-${env} topic into a
#     Dataflow streaming insert job. The actual Dataflow job resource is NOT
#     created here — Dataflow job terraform resources are bespoke and usually
#     live in a dedicated template. We provision the BQ side + the subscription
#     + SA bindings; the Dataflow job is stood up out-of-band with the same
#     SA and pinned to these resources.

locals {
  labels = {
    service    = "bigquery-sink"
    env        = var.environment
    managed_by = "terraform"
  }
}

resource "google_bigquery_dataset" "developer_proxy_usage" {
  project                    = var.project_id
  dataset_id                 = "developer_proxy_usage_${var.environment}"
  friendly_name              = "Developer Proxy Usage — ${var.environment}"
  description                = "Streaming developer-proxy usage events; 90-day OLTP retention in Postgres, full history here."
  location                   = var.region
  delete_contents_on_destroy = false
  labels                     = local.labels

  dynamic "default_encryption_configuration" {
    for_each = var.kms_key_id == "" ? [] : [1]
    content {
      kms_key_name = var.kms_key_id
    }
  }
}

resource "google_bigquery_table" "developer_proxy_usage_events" {
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.developer_proxy_usage.dataset_id
  table_id            = "developer_proxy_usage_events"
  deletion_protection = var.environment == "prod"

  time_partitioning {
    type  = "DAY"
    field = "occurred_at"
  }

  clustering = ["tenant_id", "agent_id", "vendor", "user_id"]

  schema = jsonencode([
    { name = "event_id", type = "STRING", mode = "REQUIRED" },
    { name = "tenant_id", type = "STRING", mode = "REQUIRED" },
    { name = "user_id", type = "STRING", mode = "NULLABLE" },
    { name = "vendor", type = "STRING", mode = "REQUIRED" },
    { name = "model", type = "STRING", mode = "NULLABLE" },
    { name = "input_tokens", type = "INT64", mode = "NULLABLE" },
    { name = "output_tokens", type = "INT64", mode = "NULLABLE" },
    { name = "cost_cents", type = "INT64", mode = "NULLABLE" },
    { name = "occurred_at", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "ingested_at", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "raw_payload", type = "JSON", mode = "NULLABLE" },
    { name = "agent_id", type = "STRING", mode = "NULLABLE" },
    { name = "action_id", type = "STRING", mode = "NULLABLE" },
    { name = "invocation_id", type = "STRING", mode = "NULLABLE" },
  ])

  labels = local.labels

  lifecycle {
    # Table inherits CMEK from the dataset's default_encryption_configuration;
    # Terraform must not try to remove it at the table level.
    ignore_changes = [encryption_configuration]
  }
}

# BQ editor for the Dataflow SA.
resource "google_bigquery_dataset_iam_member" "dataflow_developer_proxy" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.developer_proxy_usage.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${var.dataflow_service_account}"
}

# Subscription on developer-proxy-usage topic consumed by Dataflow. Dataflow job
# terraform lives out-of-module; this subscription is what it binds to.
resource "google_pubsub_subscription" "developer_proxy_usage_to_bq" {
  project = var.project_id
  name    = "developer-proxy-usage-${var.environment}-to-bq"
  topic   = var.developer_proxy_usage_topic

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  expiration_policy {
    ttl = ""
  }

  labels = local.labels
}

# ─── Optional mirror datasets ────────────────────────────────────────────────
resource "google_bigquery_dataset" "governance_audit" {
  count = var.enable_governance_audit_mirror ? 1 : 0

  project       = var.project_id
  dataset_id    = "governance_audit_${var.environment}"
  friendly_name = "Governance Audit Mirror — ${var.environment}"
  location      = var.region
  labels        = local.labels

  dynamic "default_encryption_configuration" {
    for_each = var.kms_key_id == "" ? [] : [1]
    content {
      kms_key_name = var.kms_key_id
    }
  }
}

resource "google_pubsub_subscription" "governance_audit_to_bq" {
  count = var.enable_governance_audit_mirror ? 1 : 0

  project = var.project_id
  name    = "governance-audit-${var.environment}-to-bq"
  topic   = var.governance_audit_topic

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  labels = local.labels
}

# ─── Dataflow flex-template job ───────────────────────────────────────────────
# Google-provided `PubSub_Subscription_to_BigQuery` flex template — the
# standard pattern. Pinned rather than custom-built so the job stays
# boring + auditable. Failed messages land in a deadletter table.

resource "google_storage_bucket" "dataflow_staging" {
  count = var.enable_dataflow_job ? 1 : 0

  project                     = var.project_id
  name                        = "${var.project_id}-dataflow-staging"
  location                    = var.region
  force_destroy               = var.environment != "prod"
  uniform_bucket_level_access = true

  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "Delete"
    }
  }

  labels = local.labels
}

resource "google_bigquery_table" "developer_proxy_usage_deadletter" {
  count = var.enable_dataflow_job ? 1 : 0

  project             = var.project_id
  dataset_id          = google_bigquery_dataset.developer_proxy_usage.dataset_id
  table_id            = "developer_proxy_usage_events_deadletter"
  deletion_protection = var.environment == "prod"

  schema = jsonencode([
    { name = "timestamp", type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "payloadString", type = "STRING", mode = "NULLABLE" },
    { name = "payloadBytes", type = "BYTES", mode = "NULLABLE" },
    {
      name = "attributes", type = "RECORD", mode = "REPEATED",
      fields = [
        { name = "key", type = "STRING" },
        { name = "value", type = "STRING" },
      ]
    },
    { name = "errorMessage", type = "STRING", mode = "NULLABLE" },
    { name = "stacktrace", type = "STRING", mode = "NULLABLE" },
  ])

  labels = local.labels
}

resource "google_dataflow_flex_template_job" "developer_proxy_usage_to_bq" {
  count = var.enable_dataflow_job ? 1 : 0

  provider                = google-beta
  project                 = var.project_id
  region                  = var.region
  name                    = "developer-proxy-usage-to-bq-${var.environment}"
  container_spec_gcs_path = var.dataflow_template_gcs_path

  parameters = {
    inputSubscription     = "projects/${var.project_id}/subscriptions/${google_pubsub_subscription.developer_proxy_usage_to_bq.name}"
    outputTableSpec       = "${var.project_id}:${google_bigquery_dataset.developer_proxy_usage.dataset_id}.${google_bigquery_table.developer_proxy_usage_events.table_id}"
    outputDeadletterTable = "${var.project_id}:${google_bigquery_dataset.developer_proxy_usage.dataset_id}.developer_proxy_usage_events_deadletter"
    serviceAccount        = var.dataflow_service_account
    tempLocation          = "gs://${google_storage_bucket.dataflow_staging[0].name}/temp"
    stagingLocation       = "gs://${google_storage_bucket.dataflow_staging[0].name}/staging"
  }

  on_delete = var.environment == "prod" ? "drain" : "cancel"

  labels = local.labels
}

output "developer_proxy_usage_dataset_id" {
  value = google_bigquery_dataset.developer_proxy_usage.dataset_id
}

# ─── GCP Billing Export dataset ──────────────────────────────────────────────
# Receives standard usage cost data exported from Cloud Billing.
# Dataset is created here; the export itself is enabled in GCP Console:
#   Billing → Billing export → Standard usage cost → select this dataset.
# Location is US (multi-region) — required for GCP Billing export.
resource "google_bigquery_dataset" "gcp_billing_export" {
  count = var.enable_gcp_billing_export ? 1 : 0

  project       = var.project_id
  dataset_id    = "gcp_billing_export_${var.environment}"
  friendly_name = "GCP Billing Export — ${var.environment}"
  description   = "Standard usage cost billing export from Cloud Billing. Source for the cost-attribution gcp-billing-ingester."
  location      = "US"
  labels        = local.labels
}

resource "google_bigquery_dataset_iam_member" "platform_backend_billing_reader" {
  count = var.enable_gcp_billing_export && var.platform_backend_service_account != "" ? 1 : 0

  project    = var.project_id
  dataset_id = google_bigquery_dataset.gcp_billing_export[0].dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${var.platform_backend_service_account}"
}

output "gcp_billing_export_dataset_id" {
  value = var.enable_gcp_billing_export ? google_bigquery_dataset.gcp_billing_export[0].dataset_id : ""
}

output "dataflow_job_id" {
  value       = var.enable_dataflow_job ? google_dataflow_flex_template_job.developer_proxy_usage_to_bq[0].job_id : ""
  description = "Dataflow job ID; empty when enable_dataflow_job=false."
}
