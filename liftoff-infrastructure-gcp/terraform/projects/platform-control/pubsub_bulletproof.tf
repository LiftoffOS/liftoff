# Pub/Sub bulletproof eventing — platform-control resources.
#
# Adds the runtime_url validator + outbox-acknowledgment reconciler jobs and
# their schedulers / IAM bindings / alerts. Companion changes:
#   - terraform/projects/tenant-runtime-template/{push_endpoint_healthcheck,
#       pubsub_dlq_drainer,alerts}.tf
#   - liftoff-platform-backend/src/scripts/{validate-tenant-runtime-urls,
#       outbox-acknowledgment-reconciler}.ts
#   - liftoff-platform-backend/migrations/250_outbox_reconciler_telemetry.sql
#   - liftoff-tenant-runtime/src/{events/event-status-router,
#       scripts/push-endpoint-healthcheck,scripts/pubsub-dlq-drainer}.ts
#   - liftoff-tenant-runtime/migrations/216_failed_events.sql
#
# Rationale: the support agent's events vanished because (1) push subscriptions
# pointed at placeholder.invalid and 5xx-DLQ'd for 14 days, (2) the DLQ pull
# sub had no consumer so messages aged out, and (3) the drift reconciler's
# runtime_url was stale and silently failed. This file delivers the
# platform-control half of the fix.

# ─── runtime_url validator (Fix H) ────────────────────────────────────────

resource "google_cloud_run_v2_job" "validate_tenant_runtime_urls" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "validate-tenant-runtime-urls-${var.environment}"

  template {
    template {
      service_account = google_service_account.platform_backend.email
      timeout         = "180s"
      max_retries     = 0

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
        # Initial placeholder — cloudbuild owns the SHA tag.
        image   = "us-docker.pkg.dev/cloudrun/container/hello"
        command = ["node"]
        args    = ["dist/scripts/validate-tenant-runtime-urls.js"]

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
          value = google_project.platform_control.project_id
        }
        env {
          name  = "INTERNAL_AGENT_METRICS_PROJECT_ID"
          value = google_project.platform_control.project_id
        }
        env {
          name  = "CLOUD_SQL_CONNECTION_NAME"
          value = google_sql_database_instance.control_plane.connection_name
        }
        env {
          name  = "DB_HOST"
          value = "/cloudsql/${google_sql_database_instance.control_plane.connection_name}"
        }
        env {
          name  = "DB_USER"
          value = "liftoff_app"
        }
        env {
          name  = "DB_NAME"
          value = "liftoff_control"
        }
        # NOTE: no DB_ADMIN_USER override. The platform-backend service +
        # existing Cloud Run Jobs (slack-token-rotator, backfill-pinned-
        # knowledge) all let withAdminScope fall back to DB_USER=liftoff_app
        # which is itself BYPASSRLS in this control-plane DB. Setting
        # DB_ADMIN_USER=liftoff_admin requires a separately-provisioned
        # password we don't have wired here.
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
    ignore_changes = [
      template[0].template[0].containers[0].image,
      # client/client_version are stamped by cloudbuild's gcloud run deploy;
      # ignore so plans stay clean (matches push_endpoint_healthcheck/dlq_drainer).
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.apis]
}

# Platform-backend SA needs run.viewer on platform-control so it can list
# its own services if/when ever required. Tenant-project listing IAM is
# granted in the tenant-runtime-template module via aggregate_iam-style
# binding (see tenant-runtime-template/main.tf additions).
resource "google_project_iam_member" "platform_backend_cloud_run_viewer" {
  project = google_project.platform_control.project_id
  role    = "roles/run.viewer"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_cloud_scheduler_job" "validate_tenant_runtime_urls" {
  project = google_project.platform_control.project_id
  region  = var.region
  name    = "validate-tenant-runtime-urls-${var.environment}"
  # Daily with platform-backend's housekeeping pass (housekeeping.tf). A Cloud Run
  # job keeps its own schedule: the project's VPC-SC perimeter refuses a Cloud
  # Run Admin API call made from Cloud Tasks, and admits it from Cloud Scheduler.
  schedule  = "0 15 * * *"
  time_zone = "UTC"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/${google_cloud_run_v2_job.validate_tenant_runtime_urls.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count = 0
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_validate_urls" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = google_cloud_run_v2_job.validate_tenant_runtime_urls.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# ─── outbox-acknowledgment reconciler (Fix B-2) ───────────────────────────

resource "google_cloud_run_v2_job" "outbox_ack_reconciler" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "outbox-ack-reconciler-${var.environment}"

  template {
    template {
      service_account = google_service_account.platform_backend.email
      timeout         = "300s"
      max_retries     = 0

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
        image   = "us-docker.pkg.dev/cloudrun/container/hello"
        command = ["node"]
        args    = ["dist/scripts/outbox-acknowledgment-reconciler.js"]

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
          value = google_project.platform_control.project_id
        }
        env {
          name  = "INTERNAL_AGENT_METRICS_PROJECT_ID"
          value = google_project.platform_control.project_id
        }
        env {
          name  = "CLOUD_SQL_CONNECTION_NAME"
          value = google_sql_database_instance.control_plane.connection_name
        }
        env {
          name  = "DB_HOST"
          value = "/cloudsql/${google_sql_database_instance.control_plane.connection_name}"
        }
        env {
          name  = "DB_USER"
          value = "liftoff_app"
        }
        env {
          name  = "DB_NAME"
          value = "liftoff_control"
        }
        # NOTE: see runtime_url validator above — admin pool falls back to
        # DB_USER. liftoff_admin has no DB password wired here.
        env {
          # Secret `tenant-runtime-service-token` is provisioned out-of-band
          # (see main.tf:2158 platform-backend module env_vars block). Reference
          # by secret_id literal because there is no Terraform resource handle.
          name = "TENANT_RUNTIME_SERVICE_TOKEN"
          value_source {
            secret_key_ref {
              secret  = "tenant-runtime-service-token"
              version = "latest"
            }
          }
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
    ignore_changes = [
      template[0].template[0].containers[0].image,
      # client/client_version are stamped by cloudbuild's gcloud run deploy;
      # ignore so plans stay clean (matches push_endpoint_healthcheck/dlq_drainer).
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "outbox_ack_reconciler" {
  project = google_project.platform_control.project_id
  region  = var.region
  name    = "outbox-ack-reconciler-${var.environment}"
  # Daily with platform-backend's housekeeping pass (housekeeping.tf). A Cloud Run
  # job keeps its own schedule: the project's VPC-SC perimeter refuses a Cloud
  # Run Admin API call made from Cloud Tasks, and admits it from Cloud Scheduler.
  schedule  = "0 15 * * *"
  time_zone = "UTC"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/${google_cloud_run_v2_job.outbox_ack_reconciler.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count = 0
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_outbox_ack_reconciler" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = google_cloud_run_v2_job.outbox_ack_reconciler.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# ─── Metric descriptors ───────────────────────────────────────────────────
#
# Custom metric descriptors must exist BEFORE alert policies can reference
# them — otherwise terraform apply fails with "Cannot find metric(s) that
# match type = …". Declaring the descriptors here makes them part of the
# same plan as the alerts; the descriptors are created first, then the alerts
# bind to them via depends_on. Pattern mirrors
# tenant-runtime-template/agent_creation_resilience.tf:259 (drift_count).
#
# Alert I (`reconciler_errors`) is intentionally NOT here — the existing
# drift reconciler emits to INTERNAL_AGENT_METRICS_PROJECT_ID, which
# main.tf:2642 sets to YOUR_TENANT_PROJECT. The descriptor + alert for
# reconciler_errors live alongside drift_count in
# tenant-runtime-template/agent_creation_resilience.tf so they share the
# same emission project.

resource "google_monitoring_metric_descriptor" "runtime_url_invalid" {
  project      = google_project.platform_control.project_id
  type         = "custom.googleapis.com/liftoff/tenants/runtime_url_invalid"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  display_name = "Tenant runtime_url invalid"
  description  = "1 when validate-tenant-runtime-urls couldn't confirm a tenant's runtime_url matches the live agent-service URI; 0 when valid."

  labels {
    key         = "tenant_id"
    value_type  = "STRING"
    description = "Tenant whose runtime_url was validated."
  }
  labels {
    key         = "gcp_project_id"
    value_type  = "STRING"
    description = "Tenant project the agent-service was looked up in."
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_metric_descriptor" "outbox_republished_count" {
  project      = google_project.platform_control.project_id
  type         = "custom.googleapis.com/liftoff/outbox/republished_count"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  display_name = "Outbox rows republished by ack reconciler"
  description  = "Count of completed outbox rows the outbox-ack reconciler republished because the subscriber reported 'unknown' or 'failed'."

  labels {
    key         = "tenant_id"
    value_type  = "STRING"
    description = "Tenant the republished row belongs to (empty when scope=global)."
  }
  labels {
    key         = "scope"
    value_type  = "STRING"
    description = "global or per_tenant."
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_metric_descriptor" "outbox_stuck_24h_count" {
  project      = google_project.platform_control.project_id
  type         = "custom.googleapis.com/liftoff/outbox/stuck_24h_count"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  display_name = "Outbox rows stuck > 24h without subscriber confirmation"
  description  = "Count of completed outbox rows whose subscriber confirmation has not arrived in 24h. > 0 means an event is permanently lost unless manually republished."

  labels {
    key         = "tenant_id"
    value_type  = "STRING"
    description = "Tenant the stuck row belongs to (empty when scope=global)."
  }
  labels {
    key         = "scope"
    value_type  = "STRING"
    description = "global or per_tenant — alert C-4 fires on the global aggregate only."
  }

  depends_on = [google_project_service.apis]
}

# ─── Alerts ───────────────────────────────────────────────────────────────

# C-5: runtime_url invalid (any tenant).
resource "google_monitoring_alert_policy" "runtime_url_invalid" {
  project               = google_project.platform_control.project_id
  display_name          = "Tenant runtime_url invalid — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "Any tenant has runtime_url_invalid=1"
    condition_threshold {
      filter          = <<-EOT
        metric.type="custom.googleapis.com/liftoff/tenants/runtime_url_invalid"
        AND resource.type="global"
      EOT
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  alert_strategy { auto_close = "1800s" }
  depends_on = [google_monitoring_metric_descriptor.runtime_url_invalid]
}

# C-4: outbox rows stuck > 24h without subscriber confirmation.
resource "google_monitoring_alert_policy" "outbox_stuck_24h" {
  project               = google_project.platform_control.project_id
  display_name          = "Outbox rows stuck > 24h without subscriber confirmation — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "stuck count > 0"
    condition_threshold {
      filter          = <<-EOT
        metric.type="custom.googleapis.com/liftoff/outbox/stuck_24h_count"
        AND resource.type="global"
        AND metric.label.scope="global"
      EOT
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  alert_strategy { auto_close = "1800s" }
  depends_on = [google_monitoring_metric_descriptor.outbox_stuck_24h_count]
}

# Alert I (reconciler_errors) moved to
# tenant-runtime-template/agent_creation_resilience.tf so the descriptor +
# alert live in the same project the metric is emitted to (see notes above).

# ─── billing DLQ drainer (invocation-completed spend events) ──────────────
# ADR-018's drainer pattern applied to the billing DLQ: dead-lettered spend
# events previously had no consumer and silently expired at the 7-day
# retention. The job (liftoff-platform-backend
# src/scripts/drain-invocation-completed-dlq.ts) republishes each message to
# the live topic with a drain_attempt counter; the spend handler's triple
# idempotency (cross-ledger dedup under FOR UPDATE, ON CONFLICT DO NOTHING,
# Stripe meter identifier) makes replays no-ops for already-billed events,
# and the pull-based runtime-ingester remains the backstop for anything the
# drainer abandons. Image is stamped by PB cloudbuild step 11d, same as the
# two ADR-018 jobs above. No VPC access: the job talks only to the Pub/Sub
# API, not Cloud SQL.

resource "google_cloud_run_v2_job" "drain_invocation_completed_dlq" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = "drain-invocation-completed-dlq-${var.environment}"

  template {
    template {
      service_account = google_service_account.platform_backend.email
      timeout         = "120s"
      max_retries     = 0

      containers {
        image   = "us-docker.pkg.dev/cloudrun/container/hello"
        command = ["node"]
        args    = ["dist/scripts/drain-invocation-completed-dlq.js"]

        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }
        env {
          name  = "DLQ_SUBSCRIPTION"
          value = google_pubsub_subscription.invocation_completed_dlq_drain.id
        }
        env {
          name  = "LIVE_TOPIC"
          value = google_pubsub_topic.invocation_completed.id
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

  depends_on = [google_project_service.apis]
}

# The drainer republishes to the live topic. Subscriber on the drain sub is
# already granted above (invocation_completed_dlq_drain_subscriber).
resource "google_pubsub_topic_iam_member" "platform_backend_invocation_completed_publisher" {
  project = google_project.platform_control.project_id
  topic   = google_pubsub_topic.invocation_completed.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}

resource "google_cloud_scheduler_job" "drain_invocation_completed_dlq" {
  project = google_project.platform_control.project_id
  region  = var.region
  name    = "drain-invocation-completed-dlq-${var.environment}"
  # Daily with platform-backend's housekeeping pass (housekeeping.tf). A Cloud Run
  # job keeps its own schedule: the project's VPC-SC perimeter refuses a Cloud
  # Run Admin API call made from Cloud Tasks, and admits it from Cloud Scheduler.
  schedule  = "0 15 * * *"
  time_zone = "UTC"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/${google_cloud_run_v2_job.drain_invocation_completed_dlq.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count = 0
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_billing_dlq_drainer" {
  project  = google_project.platform_control.project_id
  location = var.region
  name     = google_cloud_run_v2_job.drain_invocation_completed_dlq.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# The outbox-ack reconciler (and the DLQ drainer above) emit custom metrics —
# outbox/republished_count, outbox/stuck_24h_count — under the platform-backend
# SA. The SA never had metricWriter, so every emission failed PERMISSION_DENIED
# and the stuck-24h alert (outbox_stuck_24h above) was blind since ADR-018
# shipped. Scoped to the control project only.
resource "google_project_iam_member" "platform_backend_metric_writer" {
  project = google_project.platform_control.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.platform_backend.email}"
}
