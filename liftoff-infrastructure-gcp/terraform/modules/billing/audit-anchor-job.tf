# Phase 0y — per-service chain-of-custody anchor job for billing.
#
# Cloud Run Job `billing-audit-anchor-${env}` runs once a day (via
# Cloud Scheduler) and publishes the last-row SHA256 of the most
# recent billing_audit_log partition to the isolated audit-anchor
# bucket provisioned by `modules/audit-anchor/`.
#
# The shared module defaults `enable_scheduler=false`; this wiring
# flips the flag for billing specifically — Phase 0y scheduler
# enablement for the first service that ships an anchor job.

resource "google_cloud_run_v2_job" "billing_audit_anchor" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = "billing-audit-anchor-${var.environment}"

  template {
    template {
      timeout         = "600s"
      service_account = google_service_account.billing.email

      # Private-IP instance: the socket mount below is not a route to it.
      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = "${local.image_repo}${startswith(var.image_sha, "sha256:") ? "@" : ":"}${var.image_sha}"
        command = ["node", "dist/audit/anchor-job.js"]
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
        # Owner, not the readonly role. The audit log is RLS with a
        # tenant-isolation policy and no role here holds BYPASSRLS, so a
        # non-owner reads zero rows — and the anchor would publish a hash over
        # an empty set while reporting success.
        env {
          name  = "DB_USER"
          value = "billing_migrate"
        }
        # config.ts defaults DB_APP_PASSWORD_SECRET to a name that exists in no
        # environment, so without this the job cannot authenticate at all.
        env {
          name  = "DB_APP_PASSWORD_SECRET"
          value = "billing-pg-migrate-password"
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

# Bucket writer binding — from the audit-anchor bucket to billing's SA.
# The bucket itself lives in `modules/audit-anchor/` and grants
# `objectCreator` on a list of allowed SAs. This output feeds into that
# module's `writer_service_accounts` variable when the billing module
# is instantiated in platform-control/main.tf.
output "audit_anchor_writer_sa_email" {
  value = var.enabled ? google_service_account.billing.email : ""
}
