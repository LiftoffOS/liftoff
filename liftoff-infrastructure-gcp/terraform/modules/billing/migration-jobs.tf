# billing: migration Cloud Run Jobs for the platform-backend → liftoff-billing atomic cutover.
#
# Three one-shot jobs executed during cutover:
#   1. billing-backfill-${env}           — bulk-copies historical billing rows from
#                                          platform-backend DB into liftoff-billing DB.
#   2. billing-replication-start-${env}  — creates the logical-replication slot on the
#                                          control-plane-pg source and starts the subscriber
#                                          on the liftoff-billing side.
#   3. billing-cutover-runner-${env}     — 7-step atomic cutover orchestrator: quiesces
#                                          writes via GCS state object, waits for lag=0,
#                                          flips routing, drains held requests, verifies,
#                                          commits or rolls back.
#
# Invoke cutover via:
#   gcloud run jobs execute billing-cutover-runner-${env} --wait --project=${project}

# ── Migration service account ─────────────────────────────────────────────────
resource "google_service_account" "billing_migration" {
  project      = var.project_id
  account_id   = "billing-migration-${var.environment}"
  display_name = "Billing Migration SA — ${var.environment}"
  description  = "Service account for billing cutover jobs (backfill, replication, cutover-runner)"
}

resource "google_project_iam_member" "billing_migration_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.billing_migration.email}"
}

resource "google_project_iam_member" "billing_migration_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.billing_migration.email}"

  condition {
    title       = "billing-migration-secrets-${var.environment}"
    description = "Scope migration SA to billing-* and platform-backend-* secrets"
    expression  = <<-EOT
      resource.name.startsWith("projects/${var.project_id}/secrets/billing-") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/billing-") ||
      resource.name.startsWith("projects/${var.project_id}/secrets/platform-backend-") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/platform-backend-")
    EOT
  }
}

resource "google_project_iam_member" "billing_migration_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.billing_migration.email}"
}

# Cutover runner writes mode.json to the quiesce state bucket.
resource "google_storage_bucket_iam_member" "billing_migration_cutover_state" {
  bucket = google_storage_bucket.billing_cutover_state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.billing_migration.email}"
}

# ── GCS quiesce state bucket (fleet-consistent mode signal) ───────────────────
# The platform-backend fleet polls gs://liftoff-billing-cutover-${env}/mode.json
# every 500 ms to read the QuiesceMode. The cutover-runner writes this object.
resource "google_storage_bucket" "billing_cutover_state" {
  project                     = var.project_id
  name                        = "liftoff-billing-cutover-${var.environment}"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true

  lifecycle_rule {
    action { type = "Delete" }
    condition { age = 7 }
  }

  labels = local.labels
}

# Platform-backend fleet reads the quiesce state object.
resource "google_storage_bucket_iam_member" "billing_quiesce_reader" {
  bucket = google_storage_bucket.billing_cutover_state.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${var.platform_backend_sa_email}"
}

# ── Migration image local ─────────────────────────────────────────────────────
locals {
  migration_image_repo = "${var.region}-docker.pkg.dev/${var.project_id}/YOUR_GCP_PROJECT${var.environment}/billing-migration"
  migration_image      = "${local.migration_image_repo}${startswith(var.migration_image_sha, "sha256:") ? "@" : ":"}${var.migration_image_sha}"
}

# ── billing-backfill ──────────────────────────────────────────────────────────
resource "google_cloud_run_v2_job" "billing_backfill" {
  count    = var.migration_image_sha != "placeholder" ? 1 : 0
  project  = var.project_id
  name     = "billing-backfill-${var.environment}"
  location = var.region
  labels   = merge(local.labels, { role = "migration" })

  template {
    template {
      service_account       = google_service_account.billing_migration.email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      max_retries           = 0
      timeout               = "21600s" # 6 h for large backfills

      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = local.migration_image
        command = ["node"]
        args    = ["dist/migration/backfill.js"]

        resources {
          limits = {
            cpu    = "2"
            memory = "2Gi"
          }
        }

        env {

          name = "ENVIRONMENT"

          value = var.environment

        }
        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "SOURCE_DB_INSTANCE_CONNECTION_NAME"
          value = var.control_plane_sql_connection_name
        }
        env {
          name  = "DEST_DB_INSTANCE_CONNECTION_NAME"
          value = var.control_plane_sql_connection_name
        }
        env {
          name  = "SOURCE_DB_NAME"
          value = "platform_backend"
        }
        env {
          name  = "DEST_DB_NAME"
          value = local.db_name
        }
        env {
          name  = "BATCH_SIZE"
          value = "1000"
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [var.control_plane_sql_connection_name]
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      # The image is pinned by the service's cloudbuild on every deploy (the
      # freshly built image), not by Terraform: a digest held in tfvars is
      # deleted by the Docker registry's 30-day cleanup as soon as its service
      # has deployed a few times, and the job then fails "image not found" on
      # its next run. The tfvars
      # digest is only the image a NEW job starts from.
      template[0].template[0].containers[0].image,
    ]
  }
}

# ── billing-replication-start ─────────────────────────────────────────────────
resource "google_cloud_run_v2_job" "billing_replication_start" {
  count    = var.migration_image_sha != "placeholder" ? 1 : 0
  project  = var.project_id
  name     = "billing-replication-start-${var.environment}"
  location = var.region
  labels   = merge(local.labels, { role = "migration" })

  template {
    template {
      service_account       = google_service_account.billing_migration.email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      max_retries           = 0
      timeout               = "3600s"

      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = local.migration_image
        command = ["node"]
        args    = ["dist/migration/start-replication.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {

          name = "ENVIRONMENT"

          value = var.environment

        }
        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "SOURCE_DB_INSTANCE_CONNECTION_NAME"
          value = var.control_plane_sql_connection_name
        }
        env {
          name  = "DEST_DB_INSTANCE_CONNECTION_NAME"
          value = var.control_plane_sql_connection_name
        }
        env {
          name  = "SOURCE_DB_NAME"
          value = "platform_backend"
        }
        env {
          name  = "DEST_DB_NAME"
          value = local.db_name
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [var.control_plane_sql_connection_name]
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      # The image is pinned by the service's cloudbuild on every deploy (the
      # freshly built image), not by Terraform: a digest held in tfvars is
      # deleted by the Docker registry's 30-day cleanup as soon as its service
      # has deployed a few times, and the job then fails "image not found" on
      # its next run. The tfvars
      # digest is only the image a NEW job starts from.
      template[0].template[0].containers[0].image,
    ]
  }
}

# ── billing-cutover-runner ────────────────────────────────────────────────────
# Implements the 7-step atomic cutover from platform-backend billing → liftoff-billing.
# Steps: (1) quiesce PB writes, (2) wait for replication lag=0, (3) verify row counts,
# (4) flip quiesce to `forwarding`, (5) drain held requests, (6) stop replication slot,
# (7) emit cutover-complete event (or rollback on any failure).
resource "google_cloud_run_v2_job" "billing_cutover_runner" {
  count    = var.migration_image_sha != "placeholder" ? 1 : 0
  project  = var.project_id
  name     = "billing-cutover-runner-${var.environment}"
  location = var.region
  labels   = merge(local.labels, { role = "cutover" })

  template {
    template {
      service_account       = google_service_account.billing_migration.email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      max_retries           = 0
      timeout               = "600s" # 10 min; holds time out at 60 s + safety margin

      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = local.migration_image
        command = ["node"]
        args    = ["dist/migration/cutover-runner.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {

          name = "ENVIRONMENT"

          value = var.environment

        }
        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "CUTOVER_BUCKET"
          value = google_storage_bucket.billing_cutover_state.name
        }
        env {
          name  = "CUTOVER_OBJECT"
          value = "mode.json"
        }
        env {
          name  = "SOURCE_DB_INSTANCE_CONNECTION_NAME"
          value = var.control_plane_sql_connection_name
        }
        env {
          name  = "DEST_DB_INSTANCE_CONNECTION_NAME"
          value = var.control_plane_sql_connection_name
        }
        env {
          name  = "SOURCE_DB_NAME"
          value = "platform_backend"
        }
        env {
          name  = "DEST_DB_NAME"
          value = local.db_name
        }
        env {
          name  = "HOLD_TIMEOUT_SECONDS"
          value = "60"
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [var.control_plane_sql_connection_name]
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      # The image is pinned by the service's cloudbuild on every deploy (the
      # freshly built image), not by Terraform: a digest held in tfvars is
      # deleted by the Docker registry's 30-day cleanup as soon as its service
      # has deployed a few times, and the job then fails "image not found" on
      # its next run. The tfvars
      # digest is only the image a NEW job starts from.
      template[0].template[0].containers[0].image,
    ]
  }
}
