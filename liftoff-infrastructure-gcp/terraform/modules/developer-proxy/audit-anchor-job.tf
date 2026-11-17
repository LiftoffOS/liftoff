# Phase 0y — daily audit-log anchor job for developer-proxy.
resource "google_cloud_run_v2_job" "developer_proxy_audit_anchor" {
  count    = var.enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = "developer-proxy-audit-anchor-${var.environment}"
  labels   = local.labels

  template {
    template {
      timeout         = "600s"
      service_account = google_service_account.developer_proxy.email

      # Private-IP instance: the socket mount is not a route to it.
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
        args    = ["dist/audit/anchor-job.js"]
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
        # The usage log is RLS. Ownership is what lets one read cover every tenant;
        # a non-owner hashes an empty set and reports success.
        env {
          name  = "DB_USER"
          value = "developer_proxy_migrate"
        }
        # Without this the app falls back to a config default secret name that
        # exists in no environment, so the job never authenticates.
        env {
          name  = "DB_APP_PASSWORD_SECRET"
          value = "developer-proxy-pg-migrate-password"
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

# Scheduling for this job lives in the shared audit-anchor module, which owns
# the bucket, the keys and one scheduler per service and is given the job URLs
# and a dedicated scheduler service account explicitly.
#
# Do not declare a second scheduler for the same job here, firing on its own
# cron as the service's own account. That account has no run.invoker, so every
# one of those runs would come back PERMISSION_DENIED — recorded only in the
# scheduler's status field, which nothing reads. Do not grant it either: the
# job does not need two schedulers, and the shared module is where scheduling
# is meant to be decided.

output "audit_anchor_writer_sa_email" {
  value = var.enabled ? google_service_account.developer_proxy.email : ""
}
