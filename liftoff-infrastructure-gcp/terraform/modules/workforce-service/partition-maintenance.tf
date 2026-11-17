# Partition maintenance for workforce_audit_log.
#
# workforce_audit_log is range-partitioned by month and managed by pg_partman.
# On Cloud SQL partman's background worker is unavailable, so `run_maintenance()`
# has to be called from outside the database: this job is that caller, and
# without it partman creates nothing and the runway silently expires.
#
# A job rather than a route on the service, because creating and attaching a
# partition requires ownership of the parent table and the service's own pool is
# deliberately not an owner. This runs with the migration credentials, which do
# own it.
#
# Daily is far more often than a monthly grain needs. That is deliberate: the
# cost is one no-op statement, and it means a missed run is never the thing
# standing between the table and a lost audit row.
resource "google_cloud_run_v2_job" "workforce_partition_maintenance" {
  count    = var.enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = "workforce-partitions-${var.environment}"
  labels   = merge(local.labels, { role = "partitions" })

  template {
    template {
      # Monthly partition DDL is a seconds-long operation. Bounded so a wedged
      # statement surfaces as a failed execution rather than running forever.
      timeout         = "900s"
      max_retries     = 1
      service_account = google_service_account.workforce.email

      # The control-plane instance is private IP only, so the Cloud SQL socket
      # alone is not enough — without VPC egress the connector cannot reach it
      # and the job dies on a dial timeout.
      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = local.image
        command = ["node"]
        args    = ["dist/jobs/partition-maintenance.js"]

        env {
          name  = "DB_NAME"
          value = local.db_name
        }
        env {
          name  = "DB_USER"
          value = "workforce_migrate"
        }
        env {
          name  = "CLOUD_SQL_CONNECTION_NAME"
          value = var.control_plane_sql_connection_name
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = "workforce-pg-migrate-password"
              version = "latest"
            }
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance { instances = [var.control_plane_sql_connection_name] }
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

# Scheduler authenticates as this service account, so it needs invoker on the
# job it is triggering. Granted explicitly rather than assumed: the audit-anchor
# scheduler in this same module has no such binding and its runs come back
# PERMISSION_DENIED, which is invisible unless you read the scheduler's status.
resource "google_cloud_run_v2_job_iam_member" "workforce_partition_maintenance_invoker" {
  count    = var.enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.workforce_partition_maintenance[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.workforce.email}"
}

resource "google_cloud_scheduler_job" "workforce_partition_maintenance_schedule" {
  count       = var.enabled ? 1 : 0
  project     = var.project_id
  region      = var.region
  name        = "workforce-partitions-${var.environment}"
  description = "Runs pg_partman maintenance for workforce_audit_log: creates upcoming monthly partitions and applies retention."
  schedule    = "15 3 * * *"
  time_zone   = "Etc/UTC"

  # Invokes the Cloud Run Jobs API, so this is an oauth_token against Google's
  # own endpoint — unlike the stuck-plan sweep next door, which posts to a route
  # on the service and therefore needs an oidc_token with an audience.
  depends_on = [google_cloud_run_v2_job_iam_member.workforce_partition_maintenance_invoker]

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.workforce_partition_maintenance[0].name}:run"
    oauth_token { service_account_email = google_service_account.workforce.email }
  }
}
