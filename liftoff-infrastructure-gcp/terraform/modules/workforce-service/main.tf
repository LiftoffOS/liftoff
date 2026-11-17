# workforce-service: Cloud Run deployment for liftoff-workforce-service.
# Phase 3 — HRBP provisioning + CAIO draft orchestration.

locals {
  service_name  = "workforce"
  sa_account_id = "workforce-${var.environment}"
  db_name       = "workforce"
  kms_key_name  = "workforce-key"
  image_repo    = "${var.region}-docker.pkg.dev/${var.project_id}/YOUR_GCP_PROJECT${var.environment}/workforce-service"
  image         = "${local.image_repo}${startswith(var.image_sha, "sha256:") ? "@" : ":"}${var.image_sha}"
  labels = {
    service    = "workforce"
    env        = var.environment
    managed_by = "terraform"
  }
}

data "google_project" "self" {
  project_id = var.project_id
}

resource "google_service_account" "workforce" {
  project      = var.project_id
  account_id   = local.sa_account_id
  display_name = "Workforce Service — ${var.environment}"
  description  = "Service account for liftoff-workforce-service (${var.environment})"
}

resource "google_project_iam_member" "workforce_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.workforce.email}"
}

resource "google_project_iam_member" "workforce_trace" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.workforce.email}"
}

resource "google_project_iam_member" "workforce_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.workforce.email}"
}

resource "google_project_iam_member" "workforce_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.workforce.email}"
}

resource "google_project_iam_member" "workforce_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.workforce.email}"

  condition {
    title       = "workforce-secrets-only-${var.environment}"
    description = "Scope Workforce SA to workforce-* secrets only (plan 0d)"
    expression  = <<-EOT
      resource.name.startsWith("projects/${var.project_id}/secrets/workforce-") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/workforce-")
    EOT
  }
}

resource "google_kms_crypto_key" "workforce" {
  name            = local.kms_key_name
  key_ring        = var.kms_key_ring_id
  rotation_period = "7776000s"
  labels          = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "workforce_key_decrypter" {
  crypto_key_id = google_kms_crypto_key.workforce.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.workforce.email}"
}

resource "google_sql_database" "workforce" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = local.db_name
}

resource "google_sql_user" "workforce_migrate" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = "workforce_migrate"
  password = var.db_migrate_password
}

resource "google_sql_user" "workforce_app" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = "workforce_app"
  password = var.db_app_password
}

resource "google_sql_user" "workforce_readonly" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = "workforce_readonly"
  password = var.db_readonly_password
}

resource "google_cloud_run_v2_service" "workforce" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = local.service_name
  location = var.region

  ingress = "INGRESS_TRAFFIC_ALL"
  labels  = local.labels

  template {
    labels                           = local.labels
    service_account                  = google_service_account.workforce.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 50
    # CAIO draft p50 < 10s TTFB; allow long tail.
    timeout = "600s"

    annotations = {
      "run.googleapis.com/terminationGracePeriodSeconds" = "35"
    }

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    vpc_access {
      network_interfaces {
        network    = var.vpc_network_id
        subnetwork = var.vpc_subnetwork_id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.image

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
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
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "DB_INSTANCE_CONNECTION_NAME"
        value = var.control_plane_sql_connection_name
      }
      env {
        name  = "DB_NAME"
        value = local.db_name
      }
      env {
        name  = "DB_USER"
        value = "workforce_app"
      }
      env {
        name  = "DB_APP_PASSWORD_SECRET"
        value = "workforce-pg-password"
      }

      # HRBP Cloud Tasks fan-out target. The task handler at
      # /api/tasks/hrbp-provision-spec verifies the OIDC token's audience
      # against this exact URL. Cloud Run synthesises the URL at provision
      # time; we publish a stable env var so the task enqueuer never has
      # to guess.
      #
      # Note: the WORKFORCE_SERVICE_TOKEN env var (consumed for both inbound
      # X-Service-Auth and outbound platform-backend calls) is wired by
      # cloudbuild's --update-secrets step after deploy, NOT here, so we
      # don't fight over the same env slot from two places.
      env {
        name  = "WORKFORCE_SERVICE_URL"
        value = "https://${local.service_name}-${data.google_project.self.number}.${var.region}.run.app"
      }
      env {
        name  = "WORKFORCE_SERVICE_ACCOUNT_EMAIL"
        value = google_service_account.workforce.email
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      liveness_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        period_seconds        = 30
        timeout_seconds       = 5
        failure_threshold     = 3
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 12
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [var.control_plane_sql_connection_name]
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    ignore_changes = [
      template[0].annotations,
      template[0].containers[0].image,
      # Cloud Build deploys additional env vars (PLATFORM_BACKEND_URL,
      # WORKFORCE_SERVICE_TOKEN, ANTHROPIC_API_KEY_SECRET) that are not
      # tracked in this module config. Preventing Terraform from removing
      # them on each apply avoids startup probe failures.
      template[0].containers[0].env,
      # GCP normalises the VPC connector short-name to a full resource path
      # after first apply; ignoring prevents a revision update every plan.
      template[0].vpc_access,
      client,
      client_version,
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "platform_backend_invoker" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  name    = google_cloud_run_v2_service.workforce[0].name
  role    = "roles/run.invoker"
  member  = "serviceAccount:${var.platform_backend_sa_email}"
}

resource "google_cloudbuild_trigger" "workforce" {
  count       = var.cloud_build_trigger_enabled ? 1 : 0
  project     = var.project_id
  name        = "liftoff-workforce-service-${var.environment}"
  description = "Build + deploy liftoff-workforce-service (${var.environment}) on push to main"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-workforce-service"
    push {
      branch = var.environment == "prod" ? "^production$" : "^main$"
    }
  }

  filename = "cloudbuild.yaml"

  substitutions = {
    _ENVIRONMENT = var.environment
    _REGION      = var.region
    _IMAGE_REPO  = local.image_repo
  }

  tags = [for k, v in local.labels : "${k}-${v}"]
}

resource "google_binary_authorization_attestor" "workforce" {
  count = var.binary_authorization_enabled ? 1 : 0

  project = var.project_id
  name    = "workforce-attestor-${var.environment}"

  attestation_authority_note {
    note_reference = google_container_analysis_note.workforce[0].name
  }
}

resource "google_container_analysis_note" "workforce" {
  count = var.binary_authorization_enabled ? 1 : 0

  project = var.project_id
  name    = "workforce-attestor-note-${var.environment}"

  attestation_authority {
    hint {
      human_readable_name = "Workforce SLSA-3 attestor (${var.environment})"
    }
  }
}

resource "google_monitoring_dashboard" "workforce" {
  count   = var.enabled ? 1 : 0
  project = var.project_id

  dashboard_json = jsonencode({
    displayName = "Workforce — ${var.environment}"
    gridLayout = {
      columns = 2
      widgets = [
        {
          title = "HRBP provisioning success"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/workforce/hrbp_provisioning_success_rate\""
                  aggregation = {
                    alignmentPeriod  = "300s"
                    perSeriesAligner = "ALIGN_MEAN"
                  }
                }
              }
            }]
          }
        },
        {
          title = "CAIO draft TTFB p50"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/workforce/caio_draft_ttfb_ms\""
                  aggregation = {
                    alignmentPeriod  = "60s"
                    perSeriesAligner = "ALIGN_PERCENTILE_50"
                  }
                }
              }
            }]
          }
        },
        {
          title = "Outbox unpublished age (s)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/workforce/outbox/oldest_unpublished_age\""
                  aggregation = {
                    alignmentPeriod  = "60s"
                    perSeriesAligner = "ALIGN_MEAN"
                  }
                }
              }
            }]
          }
        },
        {
          title = "Pub/Sub DLQ depth (workforce-events-dlq)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"pubsub_subscription\" metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" resource.labels.subscription_id=monitoring.regex.full_match(\"workforce-events-dlq-.*\")"
                  aggregation = {
                    alignmentPeriod  = "60s"
                    perSeriesAligner = "ALIGN_MEAN"
                  }
                }
              }
            }]
          }
        },
        {
          title = "PgBouncer connection pool (workforce quota)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/pgbouncer/client_active\" metric.labels.database=\"workforce\""
                  aggregation = {
                    alignmentPeriod  = "60s"
                    perSeriesAligner = "ALIGN_MEAN"
                  }
                }
              }
            }]
          }
        },
        {
          title = "SLO burn-rate (workforce-*)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"monitoring.googleapis.com/slo/burn_rate\" resource.labels.slo_name=monitoring.regex.full_match(\"workforce-.*\")"
                  aggregation = {
                    alignmentPeriod  = "300s"
                    perSeriesAligner = "ALIGN_MEAN"
                  }
                }
              }
            }]
          }
        },
        {
          title = "Circuit-breaker state per callee"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/workforce/call_policy/circuit_open_count\""
                  aggregation = {
                    alignmentPeriod  = "60s"
                    perSeriesAligner = "ALIGN_RATE"
                  }
                }
              }
            }]
          }
        },
      ]
    }
  })
}

resource "google_monitoring_metric_descriptor" "workforce_hrbp_provisioning_ok" {
  count        = var.enabled ? 1 : 0
  project      = var.project_id
  type         = "custom.googleapis.com/workforce/hrbp_provisioning_ok"
  metric_kind  = "CUMULATIVE"
  value_type   = "INT64"
  description  = "Count of successful HRBP provisioning completions."
  display_name = "Workforce HRBP Provisioning OK"
}

resource "google_monitoring_metric_descriptor" "workforce_hrbp_provisioning_attempted" {
  count        = var.enabled ? 1 : 0
  project      = var.project_id
  type         = "custom.googleapis.com/workforce/hrbp_provisioning_attempted"
  metric_kind  = "CUMULATIVE"
  value_type   = "INT64"
  description  = "Count of HRBP provisioning attempts."
  display_name = "Workforce HRBP Provisioning Attempted"
}

resource "google_monitoring_metric_descriptor" "workforce_caio_draft_ttfb_ms" {
  count        = var.enabled ? 1 : 0
  project      = var.project_id
  type         = "custom.googleapis.com/workforce/caio_draft_ttfb_ms"
  metric_kind  = "CUMULATIVE"
  value_type   = "DISTRIBUTION"
  description  = "Distribution of CAIO draft time-to-first-byte in milliseconds."
  display_name = "Workforce CAIO Draft TTFB (ms)"
}

resource "google_monitoring_service" "workforce" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service_id   = "workforce-${var.environment}"
  display_name = "Workforce (${var.environment})"

  basic_service {
    service_type = "CLOUD_RUN"
    service_labels = {
      service_name = local.service_name
      location     = var.region
    }
  }
}

resource "google_monitoring_slo" "workforce_hrbp_success" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service      = google_monitoring_service.workforce[0].service_id
  slo_id       = "workforce-hrbp-provisioning-${var.environment}"
  display_name = "Workforce — HRBP provisioning > 95%"

  goal                = 0.95
  rolling_period_days = 28

  request_based_sli {
    good_total_ratio {
      good_service_filter  = "metric.type=\"custom.googleapis.com/workforce/hrbp_provisioning_ok\" resource.type=\"global\""
      total_service_filter = "metric.type=\"custom.googleapis.com/workforce/hrbp_provisioning_attempted\" resource.type=\"global\""
    }
  }

  depends_on = [
    google_monitoring_metric_descriptor.workforce_hrbp_provisioning_ok,
    google_monitoring_metric_descriptor.workforce_hrbp_provisioning_attempted,
  ]
}

resource "google_monitoring_slo" "workforce_caio_ttfb" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service      = google_monitoring_service.workforce[0].service_id
  slo_id       = "workforce-caio-ttfb-${var.environment}"
  display_name = "Workforce — CAIO draft TTFB p50 < 10s"

  goal                = 0.95
  rolling_period_days = 28

  windows_based_sli {
    window_period = "300s"
    good_total_ratio_threshold {
      threshold = 0.95
      performance {
        distribution_cut {
          distribution_filter = "metric.type=\"custom.googleapis.com/workforce/caio_draft_ttfb_ms\" resource.type=\"global\""
          range {
            max = 10000
          }
        }
      }
    }
  }

  depends_on = [google_monitoring_metric_descriptor.workforce_caio_draft_ttfb_ms]
}

locals {
  burn_rate_thresholds = {
    "2pct"  = { lookback = "3600s", threshold = 2 }
    "5pct"  = { lookback = "3600s", threshold = 5 }
    "10pct" = { lookback = "300s", threshold = 10 }
  }
  workforce_slo_ids = var.enabled ? {
    "hrbp-success" = google_monitoring_slo.workforce_hrbp_success[0].name
    "caio-ttfb"    = google_monitoring_slo.workforce_caio_ttfb[0].name
  } : {}
  workforce_burn_alerts = {
    for pair in setproduct(keys(local.workforce_slo_ids), keys(local.burn_rate_thresholds)) :
    "${pair[0]}-${pair[1]}" => {
      slo_key  = pair[0]
      burn_key = pair[1]
    }
  }
}

resource "google_monitoring_alert_policy" "workforce_burn_rate" {
  for_each = local.workforce_burn_alerts

  project      = var.project_id
  display_name = "Workforce SLO burn — ${each.value.slo_key} ${each.value.burn_key}"
  combiner     = "OR"

  conditions {
    display_name = "burn-rate-${each.value.burn_key}"
    condition_threshold {
      filter          = <<-EOT
        select_slo_burn_rate("${local.workforce_slo_ids[each.value.slo_key]}", "${local.burn_rate_thresholds[each.value.burn_key].lookback}")
      EOT
      comparison      = "COMPARISON_GT"
      threshold_value = local.burn_rate_thresholds[each.value.burn_key].threshold
      duration        = "300s"
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = "Workforce SLO ${each.value.slo_key} burning at >${local.burn_rate_thresholds[each.value.burn_key].threshold}x. Runbook: docs/runbooks/SLO-${each.value.slo_key}.md"
    mime_type = "text/markdown"
  }
}
