# Phase 0i — daily partition-provisioning Cloud Run Job.
#
# Runs `node dist/partitions/provision.js` against the billing DB,
# creating any missing +18-month partitions. Catches gaps between
# deploys; the same script also runs in cloudbuild on every deploy.

resource "google_cloud_run_v2_job" "billing_partitions" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = "billing-partitions-${var.environment}"

  template {
    template {
      timeout         = "300s"
      service_account = google_service_account.billing.email

      # The control-plane instance is private IP only, so mounting the Cloud SQL
      # socket is not sufficient on its own — without VPC egress the connector
      # cannot reach it and the job dies on a dial timeout.
      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = "${local.image_repo}${startswith(var.image_sha, "sha256:") ? "@" : ":"}${var.image_sha}"
        command = ["node", "dist/partitions/provision.js"]
        env {
          name  = "MONTHS_AHEAD"
          value = "18"
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
          value = var.control_plane_sql_connection_name
        }
        env {
          name  = "DB_NAME"
          value = local.db_name
        }
        env {
          name  = "DB_USER"
          value = "billing_migrate"
        }
        # See the note on the retention job below: config.ts's default secret
        # name does not exist, so this has to be explicit.
        env {
          name  = "DB_APP_PASSWORD_SECRET"
          value = "billing-pg-migrate-password"
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }

      # DB_INSTANCE_CONNECTION_NAME above only tells the app where to look. The
      # socket has to be mounted and the private-IP instance has to be
      # reachable, or the job dies on
      # "connect ENOENT /cloudsql/<conn>/.s.PGSQL.5432". The migration jobs in
      # this module have carried both since they were written; these two never
      # did, which went unnoticed because they had never executed.
      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [var.control_plane_sql_connection_name]
        }
      }
    }
  }

  labels = local.labels

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

# Invoker on the job this scheduler triggers. Without it every daily run returns
# PERMISSION_DENIED and the job never executes once — visible only in the
# scheduler's status field, since it still reports ENABLED. billing_audit_log
# then keeps only the partitions migration 001 created.
resource "google_cloud_run_v2_job_iam_member" "billing_partitions_invoker" {
  count    = var.enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.billing_partitions[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.billing.email}"
}

resource "google_cloud_scheduler_job" "billing_partitions_schedule" {
  count = var.enabled ? 1 : 0

  project   = var.project_id
  region    = var.region
  name      = "billing-partitions-${var.environment}"
  schedule  = "0 1 * * *" # 01:00 UTC daily
  time_zone = "Etc/UTC"

  depends_on = [google_cloud_run_v2_job_iam_member.billing_partitions_invoker]

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/billing-partitions-${var.environment}:run"
    oauth_token {
      service_account_email = google_service_account.billing.email
    }
  }
}

# ── Gap 5 — 7-year retention / cold-storage for billing_audit_log ──────────

resource "google_storage_bucket" "billing_audit_cold_storage" {
  count = var.enabled ? 1 : 0

  project                     = var.project_id
  name                        = "liftoff-billing-audit-cold-${var.environment}"
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true

  retention_policy {
    retention_period = 7 * 365 * 24 * 3600
    is_locked        = var.environment == "prod"
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.billing.id
  }

  lifecycle_rule {
    condition { age = 7 * 365 }
    action { type = "Delete" }
  }

  labels = local.labels

  depends_on = [google_kms_crypto_key_iam_member.billing_key_gcs_encrypter]
}

resource "google_cloud_run_v2_job" "billing_audit_retention" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = "billing-audit-retention-${var.environment}"

  template {
    template {
      timeout         = "1800s"
      service_account = google_service_account.billing.email

      # Private-IP instance: the socket mount below needs VPC egress to reach it.
      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = "${local.image_repo}${startswith(var.image_sha, "sha256:") ? "@" : ":"}${var.image_sha}"
        command = ["node", "dist/partitions/retention.js"]
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
          value = var.control_plane_sql_connection_name
        }
        env {
          name  = "DB_NAME"
          value = local.db_name
        }
        env {
          name  = "DB_USER"
          value = "billing_migrate"
        }
        # Must be set explicitly. config.ts defaults DB_APP_PASSWORD_SECRET to
        # "billing-app-password", which does not exist — the service sets this
        # var so it never hit the default, and the job did not, so the first
        # execution that got far enough to try died on
        # "Secret [billing-app-password] not found". Migrate password, because
        # DB_USER above is billing_migrate.
        env {
          name  = "DB_APP_PASSWORD_SECRET"
          value = "billing-pg-migrate-password"
        }
        env {
          name  = "RETENTION_YEARS"
          value = "7"
        }
        env {
          name  = "COLD_STORAGE_BUCKET"
          value = google_storage_bucket.billing_audit_cold_storage[0].name
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

  labels = local.labels

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

# Invoker on the job this scheduler triggers — same requirement as the
# partitions scheduler above, and the same silent outcome without it: the 7-year
# retention sweep never runs.
resource "google_cloud_run_v2_job_iam_member" "billing_audit_retention_invoker" {
  count    = var.enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.billing_audit_retention[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.billing.email}"
}

resource "google_cloud_scheduler_job" "billing_audit_retention_schedule" {
  count = var.enabled ? 1 : 0

  project   = var.project_id
  region    = var.region
  name      = "billing-audit-retention-${var.environment}"
  schedule  = "0 4 1 * *" # 04:00 UTC on the 1st of each month
  time_zone = "Etc/UTC"

  depends_on = [google_cloud_run_v2_job_iam_member.billing_audit_retention_invoker]

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/billing-audit-retention-${var.environment}:run"
    oauth_token {
      service_account_email = google_service_account.billing.email
    }
  }
}

resource "google_storage_bucket_iam_member" "billing_audit_cold_writer" {
  count = var.enabled ? 1 : 0

  bucket = google_storage_bucket.billing_audit_cold_storage[0].name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.billing.email}"
}
