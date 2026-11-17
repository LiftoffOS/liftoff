# DLQ drainer — ONE Cloud Run Job and one daily Cloud Scheduler job draining
# every control-plane DLQ (DLQ_PAIRS). It was a job and a schedule per DLQ: eight
# container starts an hour for a backstop that usually finds nothing. A message
# waits at most a day here, well inside the DLQ's 7-day retention.
# Required because the DLQ pull subscription has no consumer; without this,
# messages age out at the 7-day retention boundary (the failure mode that
# erased the support agent's events).

resource "google_service_account" "dlq_drainer" {
  project      = google_project.tenant_runtime.project_id
  account_id   = "dlq-drainer-${var.environment}"
  display_name = "Pub/Sub DLQ drainer — ${var.environment}"
}

# pubsub.subscriber on each DLQ subscription (defined in agent_creation_resilience.tf).
resource "google_pubsub_subscription_iam_member" "dlq_drainer_pulls" {
  for_each     = toset(local.control_plane_subscription_topics)
  project      = google_project.tenant_runtime.project_id
  subscription = "${each.value}-${var.environment}-dlq-sub"
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.dlq_drainer.email}"
}

# pubsub.publisher on the LIVE topic (cross-project) so it can republish.
resource "google_pubsub_topic_iam_member" "dlq_drainer_publishes" {
  for_each = toset(local.control_plane_subscription_topics)
  project  = "YOUR_GCP_PROJECT${var.environment}"
  topic    = "${each.value}-${var.environment}"
  role     = "roles/pubsub.publisher"
  member   = "serviceAccount:${google_service_account.dlq_drainer.email}"
}

# secretmanager.secretAccessor on tenant-db-password so the Cloud Run Job can
# resolve the DB_PASSWORD secret_key_ref at container boot. Same pattern as
# compute_sa_tenant_db_password (main.tf:1102) for the psql break-glass job.
resource "google_secret_manager_secret_iam_member" "dlq_drainer_db_password" {
  project   = google_project.tenant_runtime.project_id
  secret_id = "tenant-db-password"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.dlq_drainer.email}"
}

resource "google_cloud_run_v2_job" "pubsub_dlq_drainer" {
  count = var.split_services_deployed ? 1 : 0

  project  = google_project.tenant_runtime.project_id
  location = var.region
  name     = "pubsub-dlq-drainer-${var.environment}"

  template {
    template {
      service_account = google_service_account.dlq_drainer.email
      timeout         = "900s" # eight DLQs in one execution, each a pull and a batch
      max_retries     = 0

      vpc_access {

        network_interfaces {

          network = google_compute_network.tenant_vpc.id

          subnetwork = google_compute_subnetwork.tenant_subnet.id

        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = data.google_cloud_run_v2_service.coordinator[0].template[0].containers[0].image
        command = ["node"]
        args    = ["dist/scripts/pubsub-dlq-drainer.js"]

        env {
          # <dlq subscription>|<live topic>, one pair per control-plane DLQ.
          name = "DLQ_PAIRS"
          value = join(",", [
            for t in local.control_plane_subscription_topics :
            "projects/${google_project.tenant_runtime.project_id}/subscriptions/${t}-${var.environment}-dlq-sub|projects/YOUR_GCP_PROJECT${var.environment}/topics/${t}-${var.environment}"
          ])
        }
        env {
          name  = "TENANT_ID"
          value = var.tenant_id
        }
        env {
          name  = "DB_HOST"
          value = local.runtime_db_host
        }
        env {
          name  = "DB_USER"
          value = "tenant_app"
        }
        env {
          name  = "DB_NAME"
          value = "tenant_runtime"
        }
        env {
          name = "DB_PASSWORD"
          value_source {
            secret_key_ref {
              secret  = "tenant-db-password"
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
      # client/client_version are stamped by cloudbuild's gcloud run deploy;
      # ignore so plans stay clean.
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.dlq_drainer_db_password,
  ]
}

resource "google_cloud_scheduler_job" "pubsub_dlq_drainer" {
  count     = var.split_services_deployed ? 1 : 0
  project   = google_project.tenant_runtime.project_id
  region    = var.region
  name      = "pubsub-dlq-drainer-${var.environment}"
  schedule  = "0 15 * * *" # with the daily housekeeping pass
  time_zone = "UTC"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.tenant_runtime.project_id}/jobs/${google_cloud_run_v2_job.pubsub_dlq_drainer[0].name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  retry_config {
    retry_count = 0
  }
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_dlq_drainer" {
  count    = var.split_services_deployed ? 1 : 0
  project  = google_project.tenant_runtime.project_id
  location = var.region
  name     = google_cloud_run_v2_job.pubsub_dlq_drainer[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}
