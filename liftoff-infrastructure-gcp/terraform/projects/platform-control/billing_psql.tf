# Break-glass psql access to the BILLING database.
#
# Third of the psql jobs described in docs/BREAK_GLASS_DB_ACCESS.md, after
# tenant-runtime-psql and platform-backend-psql. It exists because the billing
# database had no read path at all: platform-backend-psql authenticates as
# `liftoff_app`, which can CONNECT to the `billing` database but holds no
# grants inside it, so every query there dies on "permission denied for table".
# Without a read path, a failing query can be read in the source but never
# confirmed against data.
#
# Two deliberate differences from platform-backend-psql:
#
#   1. It runs as `billing_readonly`, not the app role. That role already
#      exists (module.billing's google_sql_user) and migration 008 in
#      liftoff-billing already grants it SELECT on every billing table. The
#      existing break-glass job carries a "this can DROP TABLE" warning;
#      this one cannot write at all, which is the whole point of a job whose
#      purpose is diagnosis.
#
#   2. Billing's tables are RLS-fenced on
#      `current_setting('app.current_tenant_id', false)::uuid`, so a bare
#      SELECT raises 22023/22P02 rather than returning rows. Tenant-scoped
#      queries have to bind the scope first:
#
#        QUERY=SET app.current_tenant_id='<uuid>'; SELECT ... FROM subscriptions ...
#
# The image is billing-migrate:latest. The job needs nothing from it but a psql
# binary, and credentials come from env rather than the image. `latest` is
# published by liftoff-billing's cloudbuild specifically so this resource can be
# created: a Cloud Run job cannot be created from a tag that does not resolve,
# and the first attempt at this job failed on exactly that
# ("Image ... platform-backend-migrate:latest not found") because no such tag
# has ever existed in these repositories. After creation, that same pipeline's
# refresh-psql-job-image step repoints the job at a concrete SHA, which is why
# `image` is in ignore_changes below.

resource "google_secret_manager_secret" "billing_pg_readonly_password" {
  labels    = { type = "db-password", environment = var.environment, managed_by = "terraform" }
  project   = google_project.platform_control.project_id
  secret_id = "billing-readonly-pg-password"

  replication {
    user_managed {
      replicas {
        location = var.region
        customer_managed_encryption {
          kms_key_name = google_kms_crypto_key.secrets.id
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_kms_crypto_key_iam_member.secretmanager_secrets_key,
  ]
}

resource "google_secret_manager_secret_version" "billing_pg_readonly_password" {
  secret      = google_secret_manager_secret.billing_pg_readonly_password.id
  secret_data = random_password.billing_readonly.result
}

# The job runs as the default Compute SA, so that SA needs to read the password.
# Mirrors compute_sa_db_password in main.tf. Without it the job is created but no
# revision can start: "Permission denied on secret ... for Revision service
# account ...-compute@developer.gserviceaccount.com".
resource "google_secret_manager_secret_iam_member" "compute_sa_billing_readonly_password" {
  secret_id = google_secret_manager_secret.billing_pg_readonly_password.secret_id
  project   = google_project.platform_control.project_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_project.platform_control.number}-compute@developer.gserviceaccount.com"
}

resource "google_cloud_run_v2_job" "billing_psql_break_glass" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "billing-psql"

  template {
    template {
      service_account = "${google_project.platform_control.number}-compute@developer.gserviceaccount.com"
      max_retries     = 0
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
        image = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/YOUR_GCP_PROJECT${var.environment}/billing-migrate:latest"

        # sh, not bash: billing-migrate is node:20-alpine, which ships busybox
        # sh only. The script below is POSIX, so this costs nothing.
        #
        # Bare "$VAR" passes through Terraform unchanged; only "$${...}" is
        # interpolated. The shell expands these inside the container at runtime.
        command = ["sh", "-c"]
        args = [
          <<-EOT
          set -e
          if [ -z "$QUERY" ]; then
            echo 'ERROR: QUERY env var is required.'
            echo 'Run with: gcloud run jobs execute billing-psql --update-env-vars QUERY="SELECT ..."'
            echo 'Billing tables are RLS-fenced; bind the tenant first:'
            echo "  QUERY=SET app.current_tenant_id='<uuid>'; SELECT ... FROM subscriptions ..."
            exit 1
          fi
          echo "Running query: $QUERY"
          PGPASSWORD="$DB_PASSWORD" psql -h "/cloudsql/$CLOUD_SQL_CONNECTION_NAME" -U "$DB_USER" -d "$DB_NAME" -c "$QUERY"
          EOT
        ]

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
          value = "billing_readonly"
        }
        env {
          name  = "DB_NAME"
          value = "billing"
        }
        env {
          name  = "QUERY"
          value = "" # Always overridden via --update-env-vars at execute time
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.billing_pg_readonly_password.secret_id
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
      client,
      client_version,
      # Image is :latest and resolved at job creation; do not let every apply
      # fight that resolution.
      template[0].template[0].containers[0].image,
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_sql_database_instance.control_plane,
    google_secret_manager_secret_iam_member.compute_sa_billing_readonly_password,
    module.billing,
  ]
}

# ── Credential canary ────────────────────────────────────────────────────────
#
# terraform manages google_sql_user.password but can never read it back, so a
# database password that stops matching the secret is invisible: no plan shows
# drift, and nothing fails until something tries to log in — for a rarely used
# role like billing_readonly, possibly not until the break-glass job above
# needs it.
#
# This runs `SELECT 1` as billing_readonly on a schedule, so the next drift is a
# failed job rather than a discovery.
#
# It is a SEPARATE job rather than a scheduled run of billing-psql, and that is
# not tidiness. scheduled_work_alerts.tf deliberately excludes `.*-psql` from
# Cloud Run job-failure alerting, because ad-hoc psql jobs fail whenever an
# operator mistypes SQL — prod's top two "failures" in one week were exactly
# that, one of which paged at 00:38. A canary living under that name would fail
# silently, which is the opposite of the point. This name matches none of the
# ad-hoc patterns, so the existing cloud_run_job_execution_failed policy covers
# it with no new alerting to maintain.
#
# The query is baked in, not passed per-execution: there is no operator here and
# nothing to override.

resource "google_cloud_run_v2_job" "billing_credential_canary" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "billing-credential-canary"

  template {
    template {
      service_account = "${google_project.platform_control.number}-compute@developer.gserviceaccount.com"
      max_retries     = 0
      timeout         = "120s"

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
        image = "${var.region}-docker.pkg.dev/${google_project.platform_control.project_id}/YOUR_GCP_PROJECT${var.environment}/billing-migrate:latest"

        command = ["sh", "-c"]
        args = [
          <<-EOT
          set -e
          echo 'billing-credential-canary: authenticating as billing_readonly'
          PGPASSWORD="$DB_PASSWORD" psql -h "/cloudsql/$CLOUD_SQL_CONNECTION_NAME" -U "$DB_USER" -d "$DB_NAME" -c 'SELECT 1' >/dev/null
          echo 'billing-credential-canary: ok — the secret still matches the database'
          EOT
        ]

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
          value = "billing_readonly"
        }
        env {
          name  = "DB_NAME"
          value = "billing"
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.billing_pg_readonly_password.secret_id
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
      client,
      client_version,
      template[0].template[0].containers[0].image,
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_sql_database_instance.control_plane,
    google_secret_manager_secret_iam_member.compute_sa_billing_readonly_password,
    module.billing,
  ]
}

# Daily is the right cadence: this catches a credential that has silently gone
# wrong, and the cost of learning a day late is a day of not knowing, not an
# outage. Nothing depends on the canary to serve traffic.
resource "google_cloud_scheduler_job" "billing_credential_canary_daily" {
  project   = google_project.platform_control.project_id
  name      = "billing-credential-canary-daily"
  schedule  = "17 6 * * *"
  time_zone = "UTC"
  region    = var.region

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/${google_cloud_run_v2_job.billing_credential_canary.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}
