# apify-cost-reconcile — hourly Cloud Run Job that books every platform-funded
# Apify actor run at what Apify actually charged. Runs
# `dist/scripts/apify-cost-trueup.js --apply` from the platform-backend image
# over the last 48 hours of runs.
#
# Why a reconciler at all: a pay-per-result actor's charges land AFTER its run is
# terminal (the event counts can arrive seconds after SUCCEEDED, the USD figure
# later still). The executor waits up to 15 s for them before booking; a
# run that settles later than that is booked at the figure it carried, and this
# job books the difference under `apify:run:<id>:trueup` through the same
# consumption boundary. Runs are attributed to THIS environment through the
# usage-evidence rows, so the prod job never books a dev run. It prints its
# after-state every time and exits non-zero on a mismatch it could not close.
#
# Mirrors model_pricing_sync.tf: image starts as the placeholder and cloudbuild
# pins it to the deploy SHA on each push (update-apify-cost-reconcile-job step),
# Terraform ignores the image; Cloud SQL socket + serverless VPC connector for the
# private-IP database; Cloud Scheduler invokes the Job through the Cloud Run
# Admin API :run endpoint.
#
# The Apify token secret (`apify-platform-token`) is not Terraform-managed; it
# is read as a data source and the platform-backend SA already holds accessor
# on it (the service mounts the same secret).

data "google_secret_manager_secret" "apify_platform_token" {
  project   = google_project.platform_control.project_id
  secret_id = "apify-platform-token"
}

resource "google_cloud_run_v2_job" "apify_cost_reconcile" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "apify-cost-reconcile-${var.environment}"

  template {
    template {
      service_account = google_service_account.platform_backend.email
      max_retries     = 0 # Cloud Scheduler does its own retry on non-2xx
      timeout         = "900s"

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
        # Create-time placeholder only; cloudbuild patches the deploy SHA on every
        # push and Terraform ignores image drift (lifecycle below).
        image   = "us-docker.pkg.dev/cloudrun/container/hello"
        command = ["node"]
        args    = ["dist/scripts/apify-cost-trueup.js", "--apply"]

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
        # The ledger tables are RLS-forced and the reconciliation is cross-tenant
        # by definition; the script's reads and its bookings run under
        # withAdminScope, which needs the BYPASSRLS role on the admin pool.
        env {
          name  = "DB_ADMIN_USER"
          value = "liftoff_admin"
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
          name  = "NODE_ENV"
          value = "production"
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
        env {
          name = "APIFY_PLATFORM_TOKEN"
          value_source {
            secret_key_ref {
              secret  = data.google_secret_manager_secret.apify_platform_token.secret_id
              version = "latest"
            }
          }
        }
        # The consumption boundary can fire a Stripe meter event post-commit for
        # some row shapes; the client initialises from this key.
        env {
          name = "STRIPE_SECRET_KEY"
          value_source {
            secret_key_ref {
              secret  = "stripe-api-key-${var.environment}"
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
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.apis,
  ]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_invokes_apify_cost_reconcile" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = google_cloud_run_v2_job.apify_cost_reconcile.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# Hourly: the window is 48 h, so a run that settles late is caught within the
# hour and re-examined for two days after. Staggered by env, house convention.
resource "google_cloud_scheduler_job" "apify_cost_reconcile" {
  project     = google_project.platform_control.project_id
  name        = "apify-cost-reconcile-${var.environment}"
  description = "Book every platform-funded Apify run at what Apify charged (late-settling per-result charges) — via Cloud Run Job"
  region      = var.region
  # Daily with platform-backend's housekeeping pass (housekeeping.tf). A Cloud Run
  # job keeps its own schedule: the project's VPC-SC perimeter refuses a Cloud
  # Run Admin API call made from Cloud Tasks, and admits it from Cloud Scheduler.
  schedule  = "15 15 * * *" # inside the 48 h true-up window
  time_zone = "UTC"

  http_target {
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/${google_cloud_run_v2_job.apify_cost_reconcile.name}:run"
    http_method = "POST"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count          = 2
    min_backoff_duration = "60s"
    max_backoff_duration = "300s"
  }

  depends_on = [
    google_project_service.apis,
    google_cloud_run_v2_job_iam_member.scheduler_invokes_apify_cost_reconcile,
  ]
}
