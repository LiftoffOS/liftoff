// WS-4.4 — DLQ replayer Cloud Run Job (one-shot, audited).
//
// Distinct from the continuous `pubsub-dlq-drainer` jobs in
// pubsub_dlq_drainer.tf: the drainer runs every 10 minutes and continuously
// flushes DLQ messages back to the live topic. The replayer is an
// operator-triggered one-shot that drains EVERY message currently in the DLQ
// and records each (message_id → replayed_at) in dlq_replay_audit so we have
// an immutable record of which messages were re-played in response to a
// fix.
//
// Use it after a fix lands to recover the messages stuck in the DLQ.
// Trigger: `gcloud run jobs execute pubsub-dlq-replayer-<topic>-<env>`.

resource "google_service_account" "dlq_replayer" {
  project      = google_project.tenant_runtime.project_id
  account_id   = "dlq-replayer-${var.environment}"
  display_name = "Pub/Sub DLQ one-shot replayer — ${var.environment}"
}

resource "google_pubsub_subscription_iam_member" "dlq_replayer_pulls" {
  for_each     = toset(local.control_plane_subscription_topics)
  project      = google_project.tenant_runtime.project_id
  subscription = "${each.value}-${var.environment}-dlq-sub"
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.dlq_replayer.email}"
}

resource "google_pubsub_topic_iam_member" "dlq_replayer_publishes" {
  for_each = toset(local.control_plane_subscription_topics)
  project  = "YOUR_GCP_PROJECT${var.environment}"
  topic    = "${each.value}-${var.environment}"
  role     = "roles/pubsub.publisher"
  member   = "serviceAccount:${google_service_account.dlq_replayer.email}"
}

resource "google_secret_manager_secret_iam_member" "dlq_replayer_db_password" {
  project   = google_project.tenant_runtime.project_id
  secret_id = "tenant-db-password"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.dlq_replayer.email}"
}

resource "google_cloud_run_v2_job" "pubsub_dlq_replayer" {
  for_each = var.split_services_deployed ? toset(local.control_plane_subscription_topics) : toset([])

  project  = google_project.tenant_runtime.project_id
  location = var.region
  name     = "pubsub-dlq-replayer-${each.value}-${var.environment}"

  template {
    template {
      service_account = google_service_account.dlq_replayer.email
      timeout         = "600s"
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
        args    = ["dist/scripts/pubsub-dlq-replayer.js"]

        env {
          name  = "DLQ_SUBSCRIPTION"
          value = "projects/${google_project.tenant_runtime.project_id}/subscriptions/${each.value}-${var.environment}-dlq-sub"
        }
        env {
          name  = "SOURCE_TOPIC"
          value = "projects/YOUR_GCP_PROJECT${var.environment}/topics/${each.value}-${var.environment}"
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
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.dlq_replayer_db_password,
  ]
}
