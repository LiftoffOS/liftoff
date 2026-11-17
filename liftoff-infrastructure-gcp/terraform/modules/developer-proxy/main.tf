# developer-proxy: Cloud Run deployment scaffold for liftoff-developer-proxy.
# Phase 1.5 of platform-backend decomposition. Developer vendor-API proxy.
# Same shape as the billing module, with these specific deltas:
#   - min-instances = 1 (plan 0d — SSE sessions are long-lived; cold starts
#     drop connections; <5ms p99 overhead budget is incompatible with cold
#     starts).
#   - NO public webhook service.
#   - Publishes developer-proxy-usage events (plan 0m — BigQuery sink consumes these).

locals {
  service_name  = "developer-proxy"
  sa_account_id = "developer-proxy-${var.environment}"
  db_name       = "developer_proxy"
  kms_key_name  = "developer-proxy-key"
  image_repo    = "${var.region}-docker.pkg.dev/${var.project_id}/YOUR_GCP_PROJECT${var.environment}/developer-proxy"
  image         = "${local.image_repo}${startswith(var.image_sha, "sha256:") ? "@" : ":"}${var.image_sha}"
  labels = {
    service    = "developer-proxy"
    env        = var.environment
    managed_by = "terraform"
  }
}

data "google_project" "self" {
  project_id = var.project_id
}

resource "google_service_account" "developer_proxy" {
  project      = var.project_id
  account_id   = local.sa_account_id
  display_name = "Developer Proxy — ${var.environment}"
  description  = "Service account for liftoff-developer-proxy (${var.environment})"
}

resource "google_project_iam_member" "developer_proxy_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.developer_proxy.email}"
}

resource "google_project_iam_member" "developer_proxy_trace" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.developer_proxy.email}"
}

resource "google_project_iam_member" "developer_proxy_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.developer_proxy.email}"
}

resource "google_project_iam_member" "developer_proxy_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.developer_proxy.email}"
}

# Secret Manager reads. The SA reads TWO namespaces: its own operational secrets
# (`developer-proxy-*`: db passwords, service/webhook tokens) AND the per-credential
# BYOK secrets it manages (`devproxy---{tenant}---{user}---{vendor}---{credentialId}`,
# see credentials/service.ts). The condition must match BOTH prefixes — narrowing it
# to only one silently strips the SA's access to the other.
resource "google_project_iam_member" "developer_proxy_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.developer_proxy.email}"

  condition {
    title       = "developer-proxy-secrets-only-${var.environment}"
    description = "Scope Developer Proxy SA to its developer-proxy-* and devproxy--- secrets"
    expression  = <<-EOT
      resource.name.startsWith("projects/${var.project_id}/secrets/developer-proxy-") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/developer-proxy-") ||
      resource.name.startsWith("projects/${var.project_id}/secrets/devproxy---") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/devproxy---")
    EOT
  }
}

# The proxy also creates a new secret per BYOK credential and adds a version to
# it. secretAccessor (above) covers reads; these two least-privilege grants add
# create + version-add.
#
# secrets.create is authorized on the PARENT project, so at create time the IAM
# condition context resource.name is `projects/{n}`, not the new secret — a
# name-prefix condition would evaluate false and block every create. It is
# therefore granted unconditionally (create-only: cannot read, add-to, or delete
# existing secrets). versions.add operates on the secret itself, so it IS scoped
# to the devproxy--- namespace.
#
# The create-only custom role is bootstrapped OUT OF BAND, not by this pipeline:
# the infrastructure-apply service account has no iam.roles.create. Create it
# once per project with:
#   gcloud iam roles create developerProxySecretCreator<Env> \
#     --project=<project> --stage=GA \
#     --permissions=secretmanager.secrets.create \
#     --title="Developer Proxy Secret Creator (<env>)"
# This binding (setIamPolicy is within the pipeline SA's power) then attaches it.
resource "google_project_iam_member" "developer_proxy_secret_creator" {
  project = var.project_id
  role    = "projects/${var.project_id}/roles/developerProxySecretCreator${title(var.environment)}"
  member  = "serviceAccount:${google_service_account.developer_proxy.email}"
}

resource "google_project_iam_member" "developer_proxy_secret_version_adder" {
  project = var.project_id
  role    = "roles/secretmanager.secretVersionAdder"
  member  = "serviceAccount:${google_service_account.developer_proxy.email}"

  condition {
    title       = "developer-proxy-secret-writes-only-${var.environment}"
    description = "Scope Developer Proxy SA version-adds to its devproxy--- per-credential secrets only"
    expression  = <<-EOT
      resource.name.startsWith("projects/${var.project_id}/secrets/devproxy---") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/devproxy---")
    EOT
  }
}

resource "google_kms_crypto_key" "developer_proxy" {
  name            = local.kms_key_name
  key_ring        = var.kms_key_ring_id
  rotation_period = "7776000s"
  labels          = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "developer_proxy_key_decrypter" {
  crypto_key_id = google_kms_crypto_key.developer_proxy.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.developer_proxy.email}"
}

resource "google_sql_database" "developer_proxy" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = local.db_name
}

resource "google_sql_user" "developer_proxy_migrate" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = "developer_proxy_migrate"
  password = var.db_migrate_password
}

resource "google_sql_user" "developer_proxy_app" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = "developer_proxy_app"
  password = var.db_app_password
}

resource "google_sql_user" "developer_proxy_readonly" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = "developer_proxy_readonly"
  password = var.db_readonly_password
}

resource "google_cloud_run_v2_service" "developer_proxy" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = local.service_name
  location = var.region

  ingress = "INGRESS_TRAFFIC_ALL"
  labels  = local.labels

  template {
    labels                = local.labels
    service_account       = google_service_account.developer_proxy.email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
    # SSE sessions are long-lived; allow more concurrent streams per instance.
    max_instance_request_concurrency = 100
    # SSE streams can last hours; Cloud Run's hard cap is 3600s on request
    # timeout anyway.
    timeout = "3600s"

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
      # PRIVATE_RANGES_ONLY: private IPs (Cloud SQL) go through the VPC connector;
      # public API calls (sqladmin.googleapis.com, Anthropic, OpenAI) go direct.
      # ALL_TRAFFIC was routing sqladmin calls through the VPC connector where the
      # vpcAccessibleServices policy blocks it, breaking Cloud SQL Auth Proxy.
    }

    containers {
      image = local.image

      resources {
        limits = {
          cpu    = "2"
          memory = "1Gi"
        }
        cpu_idle          = false
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
        value = "developer_proxy_app"
      }
      env {
        name  = "DB_APP_PASSWORD_SECRET"
        value = "developer-proxy-pg-password"
      }
      env {
        name  = "BILLING_SERVICE_URL"
        value = var.billing_service_url
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
    # this service's cloudbuild is the authoritative deployer
    # of this service's runtime: it sets the full env via --set-env-vars /
    # --set-secrets (PLATFORM_BACKEND_URL, CONTROL_PLANE_API_URL, CORS_ALLOWED_ORIGINS,
    # TENANT_RUNTIME_SERVICE_TOKEN_SECRET, BYOK_WEBHOOK_TOKEN_SECRET, ...) plus the
    # per-deploy image. Terraform owns only the service shell (scaling, ingress,
    # VPC, volumes, IAM). Without ignoring env/resources/probes, every
    # infrastructure-apply strips the cloudbuild-managed env vars it doesn't know
    # about and breaks the proxy. Matches the connector-service / governance-engine
    # / workforce-service pattern for cloudbuild-owns-env services.
    ignore_changes = [
      template[0].annotations,
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].containers[0].resources,
      template[0].containers[0].liveness_probe,
      template[0].containers[0].startup_probe,
    ]
  }
}

resource "google_cloud_run_v2_service_iam_member" "platform_backend_invoker" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  name    = google_cloud_run_v2_service.developer_proxy[0].name
  role    = "roles/run.invoker"
  member  = "serviceAccount:${var.platform_backend_sa_email}"
}

resource "google_cloudbuild_trigger" "developer_proxy" {
  count       = var.cloud_build_trigger_enabled ? 1 : 0
  project     = var.project_id
  name        = "liftoff-developer-proxy-${var.environment}"
  description = "Build + deploy liftoff-developer-proxy (${var.environment}) on push to main"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-developer-proxy"
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

resource "google_binary_authorization_attestor" "developer_proxy" {
  count = var.binary_authorization_enabled ? 1 : 0

  project = var.project_id
  name    = "developer-proxy-attestor-${var.environment}"

  attestation_authority_note {
    note_reference = google_container_analysis_note.developer_proxy[0].name
  }
}

resource "google_container_analysis_note" "developer_proxy" {
  count = var.binary_authorization_enabled ? 1 : 0

  project = var.project_id
  name    = "developer-proxy-attestor-note-${var.environment}"

  attestation_authority {
    hint {
      human_readable_name = "Developer Proxy SLSA-3 attestor (${var.environment})"
    }
  }
}

# ─── Dashboards + SLOs + burn-rate alerts ────────────────────────────────────
resource "google_monitoring_dashboard" "developer_proxy" {
  count   = var.enabled ? 1 : 0
  project = var.project_id

  dashboard_json = jsonencode({
    displayName = "Developer Proxy — ${var.environment}"
    gridLayout = {
      columns = 2
      widgets = [
        {
          title = "Proxy overhead p99 (ms)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${local.service_name}\" metric.type=\"custom.googleapis.com/developer_proxy/proxy_overhead_ms\""
                  aggregation = {
                    alignmentPeriod  = "60s"
                    perSeriesAligner = "ALIGN_PERCENTILE_99"
                  }
                }
              }
            }]
          }
        },
        {
          title = "SSE stream errors"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/developer_proxy/sse_errors\""
                  aggregation = {
                    alignmentPeriod  = "60s"
                    perSeriesAligner = "ALIGN_RATE"
                  }
                }
              }
            }]
          }
        },
        {
          title = "Active SSE sessions"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/developer_proxy/sse_active_sessions\""
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
          title = "Vendor-usage reconciliation diff"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/developer_proxy/reconciliation_diff_pct\""
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
          title = "Pub/Sub DLQ depth (developer-proxy-events-dlq)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"pubsub_subscription\" metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" resource.labels.subscription_id=monitoring.regex.full_match(\"developer-proxy-events-dlq-.*\")"
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
          title = "PgBouncer connection pool (developer_proxy quota)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/pgbouncer/client_active\" metric.labels.database=\"developer_proxy\""
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
          title = "SLO burn-rate (developer-proxy-*)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"monitoring.googleapis.com/slo/burn_rate\" resource.labels.slo_name=monitoring.regex.full_match(\"developer-proxy-.*\")"
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
                  filter = "metric.type=\"custom.googleapis.com/developer_proxy/call_policy/circuit_open_count\""
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

resource "google_monitoring_metric_descriptor" "developer_proxy_overhead_ms" {
  count        = var.enabled ? 1 : 0
  project      = var.project_id
  type         = "custom.googleapis.com/developer_proxy/proxy_overhead_ms"
  metric_kind  = "CUMULATIVE"
  value_type   = "DISTRIBUTION"
  description  = "Distribution of Developer Proxy warm-path overhead in milliseconds."
  display_name = "Developer Proxy Overhead (ms)"
}

resource "google_monitoring_metric_descriptor" "developer_proxy_sse_completed_ok" {
  count        = var.enabled ? 1 : 0
  project      = var.project_id
  type         = "custom.googleapis.com/developer_proxy/sse_completed_ok"
  metric_kind  = "CUMULATIVE"
  value_type   = "INT64"
  description  = "Count of SSE streams that completed without error."
  display_name = "Developer Proxy SSE Completed OK"
}

resource "google_monitoring_metric_descriptor" "developer_proxy_sse_started" {
  count        = var.enabled ? 1 : 0
  project      = var.project_id
  type         = "custom.googleapis.com/developer_proxy/sse_started"
  metric_kind  = "CUMULATIVE"
  value_type   = "INT64"
  description  = "Count of SSE streams started (total attempts)."
  display_name = "Developer Proxy SSE Started"
}

resource "google_monitoring_metric_descriptor" "developer_proxy_reconciliation_diff_pct" {
  count        = var.enabled ? 1 : 0
  project      = var.project_id
  type         = "custom.googleapis.com/developer_proxy/reconciliation_diff_pct"
  metric_kind  = "GAUGE"
  value_type   = "DOUBLE"
  description  = "Point-in-time vendor-usage reconciliation drift as a percentage."
  display_name = "Developer Proxy Reconciliation Diff (%)"
}

resource "google_monitoring_service" "developer_proxy" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service_id   = "developer-proxy-${var.environment}"
  display_name = "Developer Proxy (${var.environment})"

  basic_service {
    service_type = "CLOUD_RUN"
    service_labels = {
      service_name = local.service_name
      location     = var.region
    }
  }
}

resource "google_monitoring_slo" "developer_proxy_overhead" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service      = google_monitoring_service.developer_proxy[0].service_id
  slo_id       = "developer-proxy-overhead-${var.environment}"
  display_name = "Developer Proxy — warm p99 overhead < 5ms"

  goal                = 0.99
  rolling_period_days = 28

  windows_based_sli {
    window_period = "300s"
    good_total_ratio_threshold {
      threshold = 0.99
      performance {
        distribution_cut {
          distribution_filter = "metric.type=\"custom.googleapis.com/developer_proxy/proxy_overhead_ms\" resource.type=\"global\""
          range {
            max = 5
          }
        }
      }
    }
  }

  depends_on = [google_monitoring_metric_descriptor.developer_proxy_overhead_ms]
}

resource "google_monitoring_slo" "developer_proxy_sse_errors" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service      = google_monitoring_service.developer_proxy[0].service_id
  slo_id       = "developer-proxy-sse-errors-${var.environment}"
  display_name = "Developer Proxy — SSE stream error rate < 0.1%"

  goal                = 0.999
  rolling_period_days = 28

  request_based_sli {
    good_total_ratio {
      good_service_filter  = "metric.type=\"custom.googleapis.com/developer_proxy/sse_completed_ok\" resource.type=\"global\""
      total_service_filter = "metric.type=\"custom.googleapis.com/developer_proxy/sse_started\" resource.type=\"global\""
    }
  }

  depends_on = [
    google_monitoring_metric_descriptor.developer_proxy_sse_completed_ok,
    google_monitoring_metric_descriptor.developer_proxy_sse_started,
  ]
}

# Vendor-usage reconciliation diff SLO. Plan 0n target < 0.5%, alert at
# > 2%. Expressed as: fraction of 5-minute windows where the recorded
# drift metric stays under the threshold.
resource "google_monitoring_slo" "developer_proxy_vendor_reconciliation_diff" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service      = google_monitoring_service.developer_proxy[0].service_id
  slo_id       = "developer-proxy-vendor-reconciliation-diff-${var.environment}"
  display_name = "Developer Proxy — Vendor-usage reconciliation drift < 0.5%"

  goal                = 0.99
  rolling_period_days = 28

  windows_based_sli {
    window_period = "300s"
    metric_mean_in_range {
      time_series = "metric.type=\"custom.googleapis.com/developer_proxy/reconciliation_diff_pct\" resource.type=\"global\""
      range {
        max = 0.5
      }
    }
  }

  depends_on = [google_monitoring_metric_descriptor.developer_proxy_reconciliation_diff_pct]
}

locals {
  burn_rate_thresholds = {
    "2pct"  = { lookback = "3600s", threshold = 2 }
    "5pct"  = { lookback = "3600s", threshold = 5 }
    "10pct" = { lookback = "300s", threshold = 10 }
  }
  developer_proxy_slo_ids = var.enabled ? {
    "proxy-overhead"             = google_monitoring_slo.developer_proxy_overhead[0].name
    "sse-errors"                 = google_monitoring_slo.developer_proxy_sse_errors[0].name
    "vendor-reconciliation-diff" = google_monitoring_slo.developer_proxy_vendor_reconciliation_diff[0].name
  } : {}
  developer_proxy_burn_alerts = {
    for pair in setproduct(keys(local.developer_proxy_slo_ids), keys(local.burn_rate_thresholds)) :
    "${pair[0]}-${pair[1]}" => {
      slo_key  = pair[0]
      burn_key = pair[1]
    }
  }
}

resource "google_monitoring_alert_policy" "developer_proxy_burn_rate" {
  for_each = local.developer_proxy_burn_alerts

  project      = var.project_id
  display_name = "Developer Proxy SLO burn — ${each.value.slo_key} ${each.value.burn_key}"
  combiner     = "OR"

  conditions {
    display_name = "burn-rate-${each.value.burn_key}"
    condition_threshold {
      filter          = <<-EOT
        select_slo_burn_rate("${local.developer_proxy_slo_ids[each.value.slo_key]}", "${local.burn_rate_thresholds[each.value.burn_key].lookback}")
      EOT
      comparison      = "COMPARISON_GT"
      threshold_value = local.burn_rate_thresholds[each.value.burn_key].threshold
      duration        = "300s"
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = "Developer Proxy SLO ${each.value.slo_key} burning at >${local.burn_rate_thresholds[each.value.burn_key].threshold}x over ${local.burn_rate_thresholds[each.value.burn_key].lookback}. Runbook: docs/runbooks/SLO-${each.value.slo_key}.md"
    mime_type = "text/markdown"
  }
}
