# Composio migration job: force-reconnect existing cal_com / mailchimp /
# trello rows so their next agent call goes through Composio.
#
# Defaults to DRY_RUN=true so a stray `gcloud run jobs execute` cannot
# mutate the connectors table. Flip via:
#   gcloud run jobs update composio-migrate-reconnect-<env> \
#     --update-env-vars=DRY_RUN=false --region=us-west1 --project=<…>
# then execute. Reset to DRY_RUN=true after the migration.
#
# Image is the same connector-service image (var.image); CMD is overridden
# to invoke the compiled migration script. `lifecycle.ignore_changes` on
# the image attribute lets cloudbuild bump the SHA tag without tripping
# Terraform drift.

resource "google_cloud_run_v2_job" "composio_migrate_reconnect" {
  count    = var.enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = "composio-migrate-reconnect-${var.environment}"
  labels   = local.labels

  template {
    template {
      timeout         = "300s"
      max_retries     = 0
      service_account = google_service_account.connector_service.email

      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance { instances = [var.sql_connection_name] }
      }

      containers {
        image   = var.image
        command = ["node"]
        args    = ["dist/scripts/composio-migrate-reconnect.js"]

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
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
          value = var.sql_connection_name
        }
        env {
          name  = "DB_NAME"
          value = "connector_service"
        }
        env {
          name  = "DB_USER"
          value = "connector_app"
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = "connector-pg-password"
              version = "latest"
            }
          }
        }
        # withAdminScope() in src/db/pool.ts switches to DB_ADMIN_USER /
        # DB_ADMIN_PASSWORD for the UPDATE that this script issues. The
        # `connector-pg-admin-password` secret is managed out-of-band
        # (same as the live connector-service Cloud Run uses it).
        env {
          name  = "DB_ADMIN_USER"
          value = "connector_admin"
        }
        env {
          name = "DB_ADMIN_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = "connector-pg-admin-password"
              version = "latest"
            }
          }
        }
        # Default-safe. Runbook flips this to "false" before execute, then
        # back to "true" after, so a re-execute can't accidentally fire a
        # second mutation.
        env {
          name  = "DRY_RUN"
          value = "true"
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
      # cloudbuild bumps the connector-service image tag on every push to
      # main; that should NOT trip drift on this job.
      template[0].template[0].containers[0].image,
      # DRY_RUN gets toggled at execute time by the runbook procedure.
      # Treating it as drift would force operators to either edit
      # Terraform to flip the env (heavy) or fight a drift loop.
      template[0].template[0].containers[0].env,
    ]
  }
}
