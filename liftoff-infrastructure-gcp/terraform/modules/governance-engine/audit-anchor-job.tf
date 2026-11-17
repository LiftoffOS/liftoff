# Phase 0y — daily audit-log anchor job for governance-engine.
resource "google_cloud_run_v2_job" "governance_engine_audit_anchor" {
  count    = var.enabled ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = "governance-engine-audit-anchor-${var.environment}"
  labels   = local.labels

  template {
    template {
      timeout         = "600s"
      service_account = google_service_account.governance_engine.email

      # Private-IP instance: the socket mount is not a route to it.
      vpc_access {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }
      containers {
        image   = var.image
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
          value = var.sql_connection_name
        }
        env {
          name  = "DB_NAME"
          value = "governance_engine"
        }
        # governance_app owns `actions` and RLS is not FORCE there, so the owner sees
        # every row. There is no governance_readonly role in the database at all.
        env {
          name  = "DB_USER"
          value = "governance_app"
        }
        # This repo takes the password itself, not the name of a secret to
        # resolve — same shape the governance-engine service uses.
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = "governance-pg-password"
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
        cloud_sql_instance { instances = [var.sql_connection_name] }
      }
    }
  }
}

# Scheduling for this job lives in the shared audit-anchor module, which owns
# the bucket, the keys and one scheduler per service and is given the job URLs
# and a dedicated scheduler service account explicitly.
#
# Do not add a second scheduler for this job here. One firing as the service's
# own account would fail with PERMISSION_DENIED, because that account has no
# run.invoker, and the failure would show only in the scheduler's status field,
# which nothing reads. The job does not need two schedulers, and the shared
# module is where scheduling is meant to be decided.

output "audit_anchor_writer_sa_email" {
  value = var.enabled ? google_service_account.governance_engine.email : ""
}
