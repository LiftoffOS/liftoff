# model-pricing-sync — scheduled Cloud Run Job that pulls open-weights (OpenRouter)
# rates from the OpenRouter models API into the control-plane `model_pricing` table
# (platform-backend migration 285). Runs `dist/scripts/sync-model-pricing.js` from
# the platform-backend image. Mirrors the slack-token-rotator pattern:
#   - image starts at :latest, cloudbuild pins it to the deploy SHA on each push
#     (see platform-backend cloudbuild.yaml), so Terraform ignores the image attr;
#   - Cloud SQL socket + serverless VPC connector for the private-IP database;
#   - Cloud Scheduler invokes the Job via the Cloud Run Admin API :run endpoint.
# Only DB access is needed — the OpenRouter models/endpoints API is public (no key).

resource "google_cloud_run_v2_job" "model_pricing_sync" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "model-pricing-sync-${var.environment}"

  template {
    template {
      service_account = google_service_account.platform_backend.email
      max_retries     = 0 # Cloud Scheduler does its own retry on non-2xx
      timeout         = "300s"

      vpc_access {
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.main.id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.control_plane.connection_name]
        }
      }

      containers {
        # Create-time placeholder only. cloudbuild publishes SHA-tagged images (never
        # :latest), so a fresh Terraform create can't reference the platform-backend
        # image yet — use the public hello image (same pattern as backfill-pinned-knowledge).
        # The cloudbuild `update-model-pricing-sync-job` step patches this to the deploy
        # SHA on every push; Terraform ignores image drift (lifecycle below).
        image   = "us-docker.pkg.dev/cloudrun/container/hello"
        command = ["node"]
        args    = ["dist/scripts/sync-model-pricing.js"]

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name  = "CLOUD_SQL_CONNECTION_NAME"
          value = google_sql_database_instance.control_plane.connection_name
        }
        env {
          name  = "DB_USER"
          value = "liftoff_app"
        }
        env {
          name  = "DB_NAME"
          value = "liftoff_control"
        }
        env {
          name  = "DB_HOST"
          value = "/cloudsql/${google_sql_database_instance.control_plane.connection_name}"
        }
        env {
          name  = "GCP_PROJECT_ID"
          value = google_project.platform_control.project_id
        }
        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_password.secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  lifecycle {
    # cloudbuild owns the image SHA; don't trip drift on every Terraform plan.
    ignore_changes = [
      template[0].template[0].containers[0].image,
      # client/client_version are stamped by cloudbuild's gcloud run deploy;
      # ignore so plans stay clean (matches push_endpoint_healthcheck/dlq_drainer).
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.apis,
  ]
}

# Allow the Cloud Scheduler SA to invoke the Job.
resource "google_cloud_run_v2_job_iam_member" "scheduler_invokes_model_pricing_sync" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = google_cloud_run_v2_job.model_pricing_sync.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# Daily refresh. Rates move slowly; daily is ample. Staggered by env so the two
# backends don't hit the OpenRouter API in the same minute (cosmetic, matches the
# house stagger convention).
resource "google_cloud_scheduler_job" "model_pricing_sync" {
  project     = google_project.platform_control.project_id
  name        = "model-pricing-sync-${var.environment}"
  description = "Refresh open-weights (OpenRouter) rates in the model_pricing table — via Cloud Run Job"
  region      = var.region
  schedule    = var.environment == "prod" ? "0 5 * * *" : "30 5 * * *"
  time_zone   = "UTC"

  http_target {
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/${google_cloud_run_v2_job.model_pricing_sync.name}:run"
    http_method = "POST"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "30s"
    max_backoff_duration = "120s"
  }

  depends_on = [
    google_project_service.apis,
    google_cloud_run_v2_job_iam_member.scheduler_invokes_model_pricing_sync,
  ]
}
