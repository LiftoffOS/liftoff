# CollabSkill eval-substrate BigQuery surface.
#
# The trajectory bucket is US-WEST1; a US multi-region dataset cannot reference a
# us-west1 bucket (BigQuery external-table colocation rules), so these tables live
# in a dedicated us-west1 dataset with a co-located BigLake connection. The legacy
# `agent_diagnostics` (US) dataset is untouched.
#
# All resources are gated on the same var.agent_diagnostics_enabled flag.

variable "diagnostics_analytics_principal" {
  description = "Optional principal (user:/group:/serviceAccount:) granted read access to the collab-skill datasets for notebook analysis. Empty = no grant."
  type        = string
  default     = ""
}

variable "collab_rollup_invoker_principal" {
  description = "Principal granted run.invoker on the governance-engine-collab-rollup job (operator/automation that executes the rollup). Empty = no grant."
  type        = string
  default     = ""
}

variable "diagnostics_grader_enabled" {
  description = "Enable the deliverable grader on job-driven diagnostics passes."
  type        = string
  default     = "false"
}

variable "diagnostics_grader_judges" {
  description = "Comma-separated provider:tier judge specs for the grader (blank = built-in default mix)."
  type        = string
  default     = ""
}

variable "diagnostics_rubric_model" {
  description = "provider:tier for rubric generation (blank = anthropic:flagship)."
  type        = string
  default     = ""
}

variable "diagnostics_grader_mode" {
  description = "Grader judging mode: 'agentic' runs each judge as a sandbox-backed agent; anything else (default) is the one-shot text judge."
  type        = string
  default     = "oneshot"
}

variable "diagnostics_labeled_set_path" {
  description = "Local path or gs:// URI of the grader calibration labeled set."
  type        = string
  default     = ""
}

locals {
  collab_bucket = "trajectories-${var.environment}"
}

# us-west1 dataset co-located with the trajectory bucket.
resource "google_bigquery_dataset" "agent_diagnostics_west" {
  count                      = var.agent_diagnostics_enabled ? 1 : 0
  project                    = var.platform_control_project_id
  dataset_id                 = "agent_diagnostics_west"
  location                   = "us-west1"
  description                = "CollabSkill eval substrate: collab sessions, rubrics, grades, calibration reports (co-located with the us-west1 trajectory bucket)."
  delete_contents_on_destroy = false
}

# BigLake cloud-resource connection (co-located with its dataset).
resource "google_bigquery_connection" "collab_biglake" {
  count         = var.agent_diagnostics_enabled ? 1 : 0
  project       = var.platform_control_project_id
  location      = "us-west1"
  connection_id = "collab-biglake"
  description   = "Delegated GCS access for the collab-skill external tables."
  cloud_resource {}
}

# The BigLake connection's delegated service account is provisioned
# asynchronously; granting it IAM immediately fails with "service account does
# not exist". Gate the grant on a short propagation pause (same pattern as
# tenant-runtime-template/pubsub_push.tf). Subsequent applies are no-ops.
resource "time_sleep" "wait_biglake_sa" {
  count           = var.agent_diagnostics_enabled ? 1 : 0
  create_duration = "60s"
  depends_on      = [google_bigquery_connection.collab_biglake]
}

# The connection's generated service agent needs to read the bucket objects.
resource "google_storage_bucket_iam_member" "collab_biglake_reader" {
  count      = var.agent_diagnostics_enabled ? 1 : 0
  bucket     = local.collab_bucket
  role       = "roles/storage.objectViewer"
  member     = "serviceAccount:${google_bigquery_connection.collab_biglake[0].cloud_resource[0].service_account_id}"
  depends_on = [time_sleep.wait_biglake_sa]
}

resource "google_bigquery_table" "collab_sessions" {
  count               = var.agent_diagnostics_enabled ? 1 : 0
  project             = var.platform_control_project_id
  dataset_id          = google_bigquery_dataset.agent_diagnostics_west[0].dataset_id
  table_id            = "collab_sessions"
  deletion_protection = false
  schema = jsonencode([
    { name = "session_id", type = "STRING" },
    { name = "tenant_id", type = "STRING" },
    { name = "agent_id", type = "STRING" },
    { name = "human_id", type = "STRING" },
    { name = "thread_id", type = "STRING" },
    { name = "triggered_by", type = "STRING" },
    { name = "task_ref", type = "STRING" },
    { name = "provider", type = "STRING" },
    { name = "model", type = "STRING" },
    { name = "outcome", type = "STRING" },
    { name = "failure_class", type = "STRING" },
    { name = "started_at", type = "TIMESTAMP" },
    { name = "completed_at", type = "TIMESTAMP" },
    { name = "duration_ms", type = "INT64" },
    { name = "cost_usd", type = "FLOAT64" },
    { name = "input_tokens", type = "INT64" },
    { name = "output_tokens", type = "INT64" },
    { name = "tool_call_count", type = "INT64" },
    { name = "n_user_messages", type = "INT64" },
    { name = "n_assistant_messages", type = "INT64" },
    { name = "n_tool_errors", type = "INT64" },
    { name = "n_distinct_tools", type = "INT64" },
    { name = "first_human_msg_idx", type = "INT64" },
    { name = "human_msg_spread", type = "FLOAT64" },
    { name = "n_hitl_requests", type = "INT64" },
    { name = "n_hitl_approved", type = "INT64" },
    { name = "n_hitl_rejected", type = "INT64" },
    { name = "trajectory_gcs_uri", type = "STRING" },
    { name = "artifact_uris", type = "STRING", mode = "REPEATED" },
    { name = "emitted_at", type = "TIMESTAMP" },
    { name = "source", type = "STRING" },
    { name = "schema_version", type = "INT64" },
  ])
  external_data_configuration {
    autodetect            = false
    source_format         = "NEWLINE_DELIMITED_JSON"
    connection_id         = google_bigquery_connection.collab_biglake[0].id
    source_uris           = ["gs://${local.collab_bucket}/diagnostics/collab_sessions/*"]
    ignore_unknown_values = true
  }
}

resource "google_bigquery_table" "collab_rubrics" {
  count               = var.agent_diagnostics_enabled ? 1 : 0
  project             = var.platform_control_project_id
  dataset_id          = google_bigquery_dataset.agent_diagnostics_west[0].dataset_id
  table_id            = "rubrics"
  deletion_protection = false
  schema = jsonencode([
    { name = "rubric_id", type = "STRING" },
    { name = "session_id", type = "STRING" },
    { name = "tenant_id", type = "STRING" },
    { name = "prompt_version", type = "STRING" },
    { name = "generated_by", type = "STRING" },
    { name = "generated_by_model", type = "STRING" },
    { name = "categories", type = "JSON" },
    { name = "created_at", type = "TIMESTAMP" },
  ])
  external_data_configuration {
    autodetect            = false
    source_format         = "NEWLINE_DELIMITED_JSON"
    connection_id         = google_bigquery_connection.collab_biglake[0].id
    source_uris           = ["gs://${local.collab_bucket}/diagnostics/rubrics/*"]
    ignore_unknown_values = true
  }
}

resource "google_bigquery_table" "collab_grades" {
  count               = var.agent_diagnostics_enabled ? 1 : 0
  project             = var.platform_control_project_id
  dataset_id          = google_bigquery_dataset.agent_diagnostics_west[0].dataset_id
  table_id            = "grades"
  deletion_protection = false
  schema = jsonencode([
    { name = "session_id", type = "STRING" },
    { name = "tenant_id", type = "STRING" },
    { name = "rubric_id", type = "STRING" },
    { name = "rubric_prompt_version", type = "STRING" },
    { name = "score_prompt_version", type = "STRING" },
    { name = "effective_config_hash", type = "STRING" },
    { name = "judges", type = "JSON" },
    { name = "score", type = "FLOAT64" },
    { name = "spread", type = "FLOAT64" },
    { name = "artifacts_present", type = "BOOL" },
    { name = "created_at", type = "TIMESTAMP" },
  ])
  external_data_configuration {
    autodetect            = false
    source_format         = "NEWLINE_DELIMITED_JSON"
    connection_id         = google_bigquery_connection.collab_biglake[0].id
    source_uris           = ["gs://${local.collab_bucket}/diagnostics/grades/*"]
    ignore_unknown_values = true
  }
}

resource "google_bigquery_table" "collab_calibration_reports" {
  count               = var.agent_diagnostics_enabled ? 1 : 0
  project             = var.platform_control_project_id
  dataset_id          = google_bigquery_dataset.agent_diagnostics_west[0].dataset_id
  table_id            = "calibration_reports"
  deletion_protection = false
  schema = jsonencode([
    { name = "calibration_run_id", type = "STRING" },
    { name = "computed_at", type = "TIMESTAMP" },
    { name = "n_labels", type = "INT64" },
    { name = "cohort_config_hash", type = "STRING" },
    { name = "pearson_r", type = "FLOAT64" },
    { name = "spearman_rho", type = "FLOAT64" },
    { name = "mae", type = "FLOAT64" },
    { name = "mean_spread", type = "FLOAT64" },
    { name = "per_judge_bias", type = "JSON" },
    { name = "score_prompt_version", type = "STRING" },
  ])
  external_data_configuration {
    autodetect            = false
    source_format         = "NEWLINE_DELIMITED_JSON"
    connection_id         = google_bigquery_connection.collab_biglake[0].id
    source_uris           = ["gs://${local.collab_bucket}/diagnostics/calibration_reports/*"]
    ignore_unknown_values = true
  }
}

# Analysis view: latest session row per session (live > backfill, then emitted_at)
# left-joined to its latest grade.
resource "google_bigquery_table" "collab_sessions_latest" {
  count               = var.agent_diagnostics_enabled ? 1 : 0
  project             = var.platform_control_project_id
  dataset_id          = google_bigquery_dataset.agent_diagnostics_west[0].dataset_id
  table_id            = "collab_sessions_latest"
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = <<-SQL
      SELECT s.* EXCEPT(rn),
             g.score AS deliverable_score,
             g.spread AS deliverable_score_spread,
             g.rubric_id,
             g.artifacts_present
      FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id ORDER BY IF(source = 'live', 0, 1), emitted_at DESC
        ) AS rn
        FROM `${var.platform_control_project_id}.agent_diagnostics_west.collab_sessions`
      ) s
      LEFT JOIN (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id ORDER BY created_at DESC
        ) AS grn
        FROM `${var.platform_control_project_id}.agent_diagnostics_west.grades`
      ) g ON g.session_id = s.session_id AND g.grn = 1
      WHERE s.rn = 1
    SQL
  }
  depends_on = [
    google_bigquery_table.collab_sessions,
    google_bigquery_table.collab_grades,
    google_storage_bucket_iam_member.collab_biglake_reader,
  ]
}

# Analytics principal: dataset reader + job user (no direct bucket access; reads
# go through the BigLake connection's delegated identity).
resource "google_bigquery_dataset_iam_member" "collab_analytics_reader" {
  count      = var.agent_diagnostics_enabled && var.diagnostics_analytics_principal != "" ? 1 : 0
  project    = var.platform_control_project_id
  dataset_id = google_bigquery_dataset.agent_diagnostics_west[0].dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = var.diagnostics_analytics_principal
}

resource "google_project_iam_member" "collab_analytics_job_user" {
  count   = var.agent_diagnostics_enabled && var.diagnostics_analytics_principal != "" ? 1 : 0
  project = var.platform_control_project_id
  role    = "roles/bigquery.jobUser"
  member  = var.diagnostics_analytics_principal
}

# GE rollup-job service account: GET-only on the consolidated match export prefix.
resource "google_storage_bucket_iam_member" "collab_ge_rollup_reader" {
  count  = var.agent_diagnostics_enabled ? 1 : 0
  bucket = local.collab_bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:governance-engine-${var.environment}@${var.platform_control_project_id}.iam.gserviceaccount.com"
  condition {
    title       = "collab-matches-export-only"
    description = "GET limited to the consolidated match export prefix."
    expression  = "resource.name.startsWith(\"projects/_/buckets/${local.collab_bucket}/objects/diagnostics/collab_matches/\")"
  }
}

# Operator/automation that runs the rollup job.
resource "google_cloud_run_v2_job_iam_member" "collab_rollup_invoker" {
  count    = var.agent_diagnostics_enabled && var.collab_rollup_invoker_principal != "" ? 1 : 0
  project  = var.platform_control_project_id
  location = var.region
  name     = "governance-engine-collab-rollup"
  role     = "roles/run.invoker"
  member   = var.collab_rollup_invoker_principal
}
