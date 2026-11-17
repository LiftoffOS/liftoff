# Monthly partition provisioning for developer_proxy_usage_log.
#
# Every element below is required for the job to reach the database, and each
# one was missing somewhere else in this estate at some point: the invoker
# binding, an image that resolves, the DB secret name, the Cloud SQL socket and
# VPC egress.

resource "google_cloud_run_v2_job" "developer_proxy_partitions" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = "developer-proxy-partitions-${var.environment}"
  labels   = local.labels

  template {
    template {
      timeout         = "600s"
      max_retries     = 1
      service_account = google_service_account.developer_proxy.email

      # The control-plane instance is private IP only, so the socket mount
      # below is not on its own a route to it.
      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = "${local.image_repo}${startswith(var.image_sha, "sha256:") ? "@" : ":"}${var.image_sha}"
        command = ["node"]
        args    = ["dist/partitions/provision.js"]

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
          value = "developer_proxy"
        }
        # Creating a partition requires ownership of the parent, which the
        # runtime role does not have — it is not even a member of the owning
        # role, despite being a member of cloudsqlsuperuser.
        env {
          name  = "DB_USER"
          value = "developer_proxy_migrate"
        }
        env {
          name  = "DB_APP_PASSWORD_SECRET"
          value = "developer-proxy-pg-migrate-password"
        }
        env {
          name  = "MONTHS_AHEAD"
          value = "18"
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

# Granted explicitly. A scheduler authenticating as an account without invoker
# on its target reports ENABLED and returns PERMISSION_DENIED on every fire,
# which shows up nowhere but the scheduler's own status field.
resource "google_cloud_run_v2_job_iam_member" "developer_proxy_partitions_invoker" {
  count    = var.enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.developer_proxy_partitions[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.developer_proxy.email}"
}

resource "google_cloud_scheduler_job" "developer_proxy_partitions" {
  count = var.enabled ? 1 : 0

  project     = var.project_id
  region      = var.region
  name        = "developer-proxy-partitions-${var.environment}"
  description = "Keeps 18 months of developer_proxy_usage_log partitions ahead of today."
  schedule    = "30 1 * * *" # daily, 01:30 UTC
  time_zone   = "Etc/UTC"

  depends_on = [google_cloud_run_v2_job_iam_member.developer_proxy_partitions_invoker]

  # Invokes the Cloud Run Jobs API, so this is an oauth_token against Google's
  # own endpoint rather than an oidc_token against a route on the service.
  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.developer_proxy_partitions[0].name}:run"
    oauth_token { service_account_email = google_service_account.developer_proxy.email }
  }

  retry_config {
    retry_count = 2
  }
}
