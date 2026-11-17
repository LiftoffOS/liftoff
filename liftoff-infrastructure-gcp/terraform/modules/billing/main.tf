# billing: Cloud Run deployment scaffold for liftoff-billing
# Phase 1 of the platform-backend decomposition.
#
# Provisioned here:
#   1. Service account + IAM wiring (Cloud SQL client, trace, logs, pubsub publisher).
#   2. Per-database role triad (billing_migrate / billing_app / billing_readonly)
#      as google_sql_user records on the shared control-plane-pg instance.
#   3. Database `billing` on control-plane-pg (no new instance — plan 0d).
#   4. Per-service KMS key `billing-key` in the shared keyring-{env}.
#   5. Secret Manager IAM scoped via IAM Condition to `billing-*` secrets only
#      (plan 0d — no project-level secretAccessor).
#   6. Cloud Run service (ingress=internal, --no-allow-unauthenticated). Gated
#      on var.enabled so plumbing can land ahead of the first image build.
#   7. Cloud Run service `billing-stripe-webhook` (public HTTPS) for the
#      /stripe/webhook endpoint — the single exception to the internal-only
#      rule in plan 0d / 1c.
#   8. Cloud Build trigger wired to this repository.
#   9. Cloud Monitoring dashboard + SLOs + burn-rate alerts (plan 0v / 0x / 0n).
#  10. Binary Authorization attestor (plan 0e — SLSA-3 provenance).
#  11. Artifact Registry cleanup-policy inheritance via the shared
#      YOUR_GCP_PROJECT AR repo.
#  12. Labels: service=billing env={env} managed_by=terraform (plan 0e).

locals {
  service_name  = "billing"
  sa_account_id = "billing-${var.environment}"
  db_name       = "billing"
  kms_key_name  = "billing-key"
  image_repo    = "${var.region}-docker.pkg.dev/${var.project_id}/YOUR_GCP_PROJECT${var.environment}/billing"
  image         = "${local.image_repo}${startswith(var.image_sha, "sha256:") ? "@" : ":"}${var.image_sha}"
  # Labels follow plan 0e — dash-separated keys are rejected by GCP, so
  # managed_by uses underscore.
  labels = {
    service    = local.service_name
    env        = var.environment
    managed_by = "terraform"
  }
}

data "google_project" "self" {
  project_id = var.project_id
}

# ─── Service Account ──────────────────────────────────────────────────────────
resource "google_service_account" "billing" {
  project      = var.project_id
  account_id   = local.sa_account_id
  display_name = "Billing Service — ${var.environment}"
  description  = "Service account for the liftoff-billing Cloud Run service (${var.environment})"
}

resource "google_project_iam_member" "billing_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.billing.email}"
}

resource "google_project_iam_member" "billing_trace" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.billing.email}"
}

resource "google_project_iam_member" "billing_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.billing.email}"
}

# billing publishes billing-events (plan 0w — producer owns the topic).
resource "google_project_iam_member" "billing_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.billing.email}"
}

# ─── Secret Manager — scoped via IAM Condition (plan 0d) ─────────────────────
# Must not grant project-level secretAccessor. Scoped to `billing-*` secrets.
resource "google_project_iam_member" "billing_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.billing.email}"

  condition {
    title       = "billing-secrets-${var.environment}"
    description = "Scope Billing SA to billing-* and stripe-* secrets (plan 0d)"
    expression  = <<-EOT
      resource.name.startsWith("projects/${var.project_id}/secrets/billing-") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/billing-") ||
      resource.name.startsWith("projects/${var.project_id}/secrets/stripe-") ||
      resource.name.startsWith("projects/${data.google_project.self.number}/secrets/stripe-")
    EOT
  }
}

# ─── Per-service KMS key (plan 0l) ───────────────────────────────────────────
resource "google_kms_crypto_key" "billing" {
  name            = local.kms_key_name
  key_ring        = var.kms_key_ring_id
  rotation_period = "7776000s" # 90d

  labels = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

# SA can decrypt secrets encrypted with this key.
resource "google_kms_crypto_key_iam_member" "billing_key_decrypter" {
  crypto_key_id = google_kms_crypto_key.billing.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_service_account.billing.email}"
}

# GCS service agent needs encrypt/decrypt on billing-key for the CMEK cold-storage bucket.
data "google_storage_project_service_account" "gcs_sa" {
  project = var.project_id
}

resource "google_kms_crypto_key_iam_member" "billing_key_gcs_encrypter" {
  crypto_key_id = google_kms_crypto_key.billing.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs_sa.email_address}"
}

resource "google_monitoring_metric_descriptor" "billing_report_usage_delivered" {
  count        = var.enabled ? 1 : 0
  project      = var.project_id
  type         = "custom.googleapis.com/billing/report_usage/delivered"
  metric_kind  = "CUMULATIVE"
  value_type   = "INT64"
  description  = "Count of ReportUsage calls successfully delivered to the usage pipeline."
  display_name = "Billing ReportUsage Delivered"
}

resource "google_monitoring_metric_descriptor" "billing_report_usage_attempted" {
  count        = var.enabled ? 1 : 0
  project      = var.project_id
  type         = "custom.googleapis.com/billing/report_usage/attempted"
  metric_kind  = "CUMULATIVE"
  value_type   = "INT64"
  description  = "Count of ReportUsage calls attempted (total)."
  display_name = "Billing ReportUsage Attempted"
}

resource "google_monitoring_metric_descriptor" "billing_meter_reconciliation_lag" {
  count        = var.enabled ? 1 : 0
  project      = var.project_id
  type         = "custom.googleapis.com/billing/meter_reconciliation_lag_seconds"
  metric_kind  = "GAUGE"
  value_type   = "DOUBLE"
  description  = "Point-in-time lag in seconds between meter events and reconciliation completion."
  display_name = "Billing Meter Reconciliation Lag (s)"
}

# ─── Database + role triad on the shared control-plane-pg instance ───────────
# Per plan 0d/0g: no new SQL instance; `billing` database on control-plane-pg.
resource "google_sql_database" "billing" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = local.db_name
}

resource "google_sql_user" "billing_migrate" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = "billing_migrate"
  password = var.db_migrate_password
}

resource "google_sql_user" "billing_app" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = "billing_app"
  password = var.db_app_password
}

resource "google_sql_user" "billing_readonly" {
  project  = var.project_id
  instance = var.control_plane_sql_instance
  name     = "billing_readonly"
  password = var.db_readonly_password
}

# ─── Cloud Run: billing ───────────────────────────────────────────────────────
# ingress=all with no-allow-unauthenticated: billing is authenticated via OIDC
# (platform-backend ServiceClient) + HMAC (X-Service-Auth). Internal-only would
# block platform-backend because its vpc-access-egress=private-ranges-only routes
# the billing public URL through internet rather than VPC, which ingress=internal
# rejects. The billing-stripe-webhook service (ingress=all, separate) handles
# public Stripe traffic.
resource "google_cloud_run_v2_service" "billing" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = local.service_name
  location = var.region

  ingress = "INGRESS_TRAFFIC_ALL"
  labels  = local.labels

  template {
    labels                           = local.labels
    service_account                  = google_service_account.billing.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 80
    timeout                          = "300s"

    # plan 0r: graceful shutdown 30s + 5s buffer.
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
          memory = "512Mi"
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
        value = "billing_app"
      }
      env {
        name  = "DB_APP_PASSWORD_SECRET"
        value = "billing-pg-password"
      }
      env {
        name  = "STRIPE_API_KEY_SECRET"
        value = "stripe-secret-key"
      }
      env {
        name  = "STRIPE_WEBHOOK_SECRET"
        value = "stripe-webhook-secret-${var.environment}"
      }
      env {
        name  = "BILLING_EVENTS_TOPIC"
        value = "billing-events-${var.environment}"
      }
      env {
        name  = "STRIPE_OU_PRICE_ID"
        value = var.stripe_ou_price_id
      }
      # Self-serve plan anchors. Empty when not set so the billing service
      # reports `plan_price_not_configured` for the affected plan instead of
      # subscribing customers under the wrong product.
      env {
        name  = "STRIPE_PLAN_CORE_MONTHLY_PRICE_ID"
        value = var.stripe_plan_core_monthly_price_id
      }
      env {
        name  = "STRIPE_PLAN_CORE_ANNUAL_PRICE_ID"
        value = var.stripe_plan_core_annual_price_id
      }
      env {
        name  = "STRIPE_PLAN_GROWTH_MONTHLY_PRICE_ID"
        value = var.stripe_plan_growth_monthly_price_id
      }
      env {
        name  = "STRIPE_PLAN_GROWTH_ANNUAL_PRICE_ID"
        value = var.stripe_plan_growth_annual_price_id
      }
      env {
        name  = "STRIPE_PLAN_SCALE_MONTHLY_PRICE_ID"
        value = var.stripe_plan_scale_monthly_price_id
      }
      env {
        name  = "STRIPE_PLAN_SCALE_ANNUAL_PRICE_ID"
        value = var.stripe_plan_scale_annual_price_id
      }
      env {
        # Used by pbClient (billing-controls-internal-router calls,
        # subscription-activated, payment-method-added, etc.). When
        # empty, pbClient.getControlsStatus short-circuits to null →
        # /current-usage falls back to NO_USAGE_DEFAULT and the
        # dashboard renders the unprovisioned-tenant shape. Must be
        # populated for any account-billing view to work.
        name  = "PLATFORM_BACKEND_URL"
        value = var.platform_backend_url
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
    ]
  }
}

# ─── Cloud Run: billing-stripe-webhook (public HTTPS, plan 1c exception) ─────
# Separated into its own Cloud Run service so the rest of `billing` stays
# private (ingress=internal). The webhook endpoint is the ONLY public surface.
# Authentication is the Stripe webhook signature; Cloud Run is configured to
# allow unauthenticated so Stripe can POST without OIDC.
resource "google_cloud_run_v2_service" "billing_stripe_webhook" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = "${local.service_name}-stripe-webhook"
  location = var.region

  ingress = "INGRESS_TRAFFIC_ALL"
  labels  = merge(local.labels, { role = "stripe-webhook" })

  template {
    labels                           = local.labels
    service_account                  = google_service_account.billing.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    max_instance_request_concurrency = 80
    timeout                          = "60s"

    annotations = {
      "run.googleapis.com/terminationGracePeriodSeconds" = "35"
    }

    scaling {
      min_instance_count = 0
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
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "ENVIRONMENT"
        value = var.environment
      }
      env {
        name  = "DB_INSTANCE_CONNECTION_NAME"
        value = var.control_plane_sql_connection_name
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
        name  = "DB_NAME"
        value = local.db_name
      }
      env {
        name  = "DB_USER"
        value = "billing_app"
      }
      env {
        name  = "DB_APP_PASSWORD_SECRET"
        value = "billing-pg-password"
      }
      env {
        name  = "STRIPE_API_KEY_SECRET"
        value = "stripe-secret-key"
      }
      env {
        name  = "STRIPE_WEBHOOK_SECRET"
        value = "stripe-webhook-secret-${var.environment}"
      }
      env {
        name  = "BILLING_EVENTS_TOPIC"
        value = "billing-events-${var.environment}"
      }
      env {
        name  = "STRIPE_OU_PRICE_ID"
        value = var.stripe_ou_price_id
      }
      # Self-serve plan anchors. Also needed on the webhook ingress for the
      # PRICE_ID_TO_PLAN_TYPE lookup in stripe-event-processor that resolves
      # planType on customer.subscription.created/updated when sub.metadata
      # is missing the field.
      env {
        name  = "STRIPE_PLAN_CORE_MONTHLY_PRICE_ID"
        value = var.stripe_plan_core_monthly_price_id
      }
      env {
        name  = "STRIPE_PLAN_CORE_ANNUAL_PRICE_ID"
        value = var.stripe_plan_core_annual_price_id
      }
      env {
        name  = "STRIPE_PLAN_GROWTH_MONTHLY_PRICE_ID"
        value = var.stripe_plan_growth_monthly_price_id
      }
      env {
        name  = "STRIPE_PLAN_GROWTH_ANNUAL_PRICE_ID"
        value = var.stripe_plan_growth_annual_price_id
      }
      env {
        name  = "STRIPE_PLAN_SCALE_MONTHLY_PRICE_ID"
        value = var.stripe_plan_scale_monthly_price_id
      }
      env {
        name  = "STRIPE_PLAN_SCALE_ANNUAL_PRICE_ID"
        value = var.stripe_plan_scale_annual_price_id
      }
      env {
        # Used by pbClient (billing-controls-internal-router calls,
        # subscription-activated, payment-method-added, etc.). When
        # empty, pbClient.getControlsStatus short-circuits to null →
        # /current-usage falls back to NO_USAGE_DEFAULT and the
        # dashboard renders the unprovisioned-tenant shape. Must be
        # populated for any account-billing view to work.
        name  = "PLATFORM_BACKEND_URL"
        value = var.platform_backend_url
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

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    ignore_changes = [
      template[0].annotations,
      template[0].containers[0].image,
    ]
  }
}

# Stripe webhook is the only route exposed publicly. Cloud Run allows
# unauthenticated invocation; signature validation happens in the handler.
resource "google_cloud_run_v2_service_iam_member" "billing_stripe_webhook_public" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  name    = google_cloud_run_v2_service.billing_stripe_webhook[0].name
  role    = "roles/run.invoker"
  member  = "allUsers"
}

# ─── IAM: platform-backend → billing (private) invoker ───────────────────────
resource "google_cloud_run_v2_service_iam_member" "platform_backend_invoker" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  name    = google_cloud_run_v2_service.billing[0].name
  role    = "roles/run.invoker"
  member  = "serviceAccount:${var.platform_backend_sa_email}"
}

# ─── Cloud Build trigger ─────────────────────────────────────────────────────
# Auto-deploys on push to main. Assumes this repository is wired into
# the Cloud Build GitHub App at the org level (same as other Liftoff repos).
resource "google_cloudbuild_trigger" "billing" {
  count       = var.cloud_build_trigger_enabled ? 1 : 0
  project     = var.project_id
  name        = "liftoff-billing-${var.environment}"
  description = "Build + deploy liftoff-billing (${var.environment}) on push to main"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-billing"
    push {
      branch = var.environment == "prod" ? "^production$" : "^main$"
    }
  }

  filename = "cloudbuild.yaml"

  substitutions = {
    _ENVIRONMENT        = var.environment
    _REGION             = var.region
    _IMAGE_REPO         = local.image_repo
    _STRIPE_OU_PRICE_ID = var.stripe_ou_price_id
  }

  tags = [for k, v in local.labels : "${k}-${v}"]
}

# ─── Binary Authorization (plan 0e — SLSA-3 provenance per-service) ──────────
resource "google_binary_authorization_attestor" "billing" {
  count = var.binary_authorization_enabled ? 1 : 0

  project = var.project_id
  name    = "billing-attestor-${var.environment}"

  attestation_authority_note {
    note_reference = google_container_analysis_note.billing[0].name
  }
}

resource "google_container_analysis_note" "billing" {
  count = var.binary_authorization_enabled ? 1 : 0

  project = var.project_id
  name    = "billing-attestor-note-${var.environment}"

  attestation_authority {
    hint {
      human_readable_name = "Billing SLSA-3 attestor (${var.environment})"
    }
  }
}

# ─── Cloud Monitoring dashboard (plan 0v) ────────────────────────────────────
resource "google_monitoring_dashboard" "billing" {
  count   = var.enabled ? 1 : 0
  project = var.project_id

  dashboard_json = jsonencode({
    displayName = "Billing — ${var.environment}"
    gridLayout = {
      columns = 2
      widgets = [
        {
          title = "Request rate"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${local.service_name}\" metric.type=\"run.googleapis.com/request_count\""
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
          title = "Error rate (5xx)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${local.service_name}\" metric.type=\"run.googleapis.com/request_count\" metric.labels.response_code_class=\"5xx\""
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
          title = "Latency p99 (ms)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${local.service_name}\" metric.type=\"run.googleapis.com/request_latencies\""
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
          title = "Latency p50 (ms)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${local.service_name}\" metric.type=\"run.googleapis.com/request_latencies\""
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
                  filter = "metric.type=\"custom.googleapis.com/billing/outbox/oldest_unpublished_age\""
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
          title = "Pub/Sub DLQ depth (billing-events-dlq)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"pubsub_subscription\" metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" resource.labels.subscription_id=monitoring.regex.full_match(\"billing-events-dlq-.*\")"
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
          title = "Pub/Sub subscription depth (billing-events consumer subs)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "resource.type=\"pubsub_subscription\" metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" resource.labels.subscription_id=monitoring.regex.full_match(\"billing-events-.*\")"
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
          title = "PgBouncer connection pool (billing quota)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"custom.googleapis.com/pgbouncer/client_active\" metric.labels.database=\"billing\""
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
          title = "SLO burn-rate (stripe-webhook + report-usage)"
          xyChart = {
            dataSets = [{
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = "metric.type=\"monitoring.googleapis.com/slo/burn_rate\" resource.labels.slo_name=monitoring.regex.full_match(\"billing-.*\")"
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
                  filter = "metric.type=\"custom.googleapis.com/billing/call_policy/circuit_open_count\""
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

# ─── SLOs + burn-rate alerts (plan 0n / 0x) ──────────────────────────────────
# SLOs from plan 0n:
#   - Stripe webhook ack p99 < 200ms (windows-based)
#   - ReportUsage end-to-end delivery < 30s (request-based)
# Meter reconciliation lag is tracked via a custom metric alert (not an SLO
# per se — it's a background-job freshness check).

resource "google_monitoring_slo" "billing_stripe_webhook_latency" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service      = google_monitoring_service.billing[0].service_id
  slo_id       = "billing-stripe-webhook-latency-${var.environment}"
  display_name = "Billing — Stripe webhook p99 < 200ms"

  goal                = 0.99
  rolling_period_days = 28

  windows_based_sli {
    window_period = "300s"
    good_total_ratio_threshold {
      threshold = 0.99
      performance {
        distribution_cut {
          distribution_filter = "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"${local.service_name}-stripe-webhook\" metric.type=\"run.googleapis.com/request_latencies\""
          range {
            max = 200
          }
        }
      }
    }
  }
}

resource "google_monitoring_slo" "billing_report_usage_delivery" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service      = google_monitoring_service.billing[0].service_id
  slo_id       = "billing-report-usage-delivery-${var.environment}"
  display_name = "Billing — ReportUsage end-to-end delivery success"

  goal                = 0.995
  rolling_period_days = 28

  request_based_sli {
    good_total_ratio {
      good_service_filter  = "metric.type=\"custom.googleapis.com/billing/report_usage/delivered\" resource.type=\"global\""
      total_service_filter = "metric.type=\"custom.googleapis.com/billing/report_usage/attempted\" resource.type=\"global\""
    }
  }

  depends_on = [
    google_monitoring_metric_descriptor.billing_report_usage_delivered,
    google_monitoring_metric_descriptor.billing_report_usage_attempted,
  ]
}

# Meter reconciliation freshness. Plan 0n target: lag < 1h, alert at
# > 4h. Tracked as a windows-based SLO where a window is "good" if
# the freshness metric is under threshold. The custom metric
# `billing/meter_reconciliation_lag_seconds` is emitted by the daily
# reconciliation job (Phase 1f).
resource "google_monitoring_slo" "billing_meter_reconciliation_lag" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service      = google_monitoring_service.billing[0].service_id
  slo_id       = "billing-meter-reconciliation-lag-${var.environment}"
  display_name = "Billing — Meter reconciliation lag < 1h"

  goal                = 0.99
  rolling_period_days = 28

  windows_based_sli {
    window_period = "300s"
    metric_mean_in_range {
      time_series = "metric.type=\"custom.googleapis.com/billing/meter_reconciliation_lag_seconds\" resource.type=\"global\""
      range {
        max = 3600
      }
    }
  }

  depends_on = [google_monitoring_metric_descriptor.billing_meter_reconciliation_lag]
}

resource "google_monitoring_service" "billing" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  service_id   = "billing-${var.environment}"
  display_name = "Billing (${var.environment})"

  basic_service {
    service_type = "CLOUD_RUN"
    service_labels = {
      service_name = local.service_name
      location     = var.region
    }
  }
}

# Burn-rate alerts at 2%, 5%, 10% per-hour; page on 10% sustained 5 min
# (plan 0x).
locals {
  burn_rate_thresholds = {
    "2pct"  = { lookback = "3600s", threshold = 2 }
    "5pct"  = { lookback = "3600s", threshold = 5 }
    "10pct" = { lookback = "300s", threshold = 10 }
  }
  billing_slo_ids = var.enabled ? {
    "stripe-webhook"           = google_monitoring_slo.billing_stripe_webhook_latency[0].name
    "report-usage"             = google_monitoring_slo.billing_report_usage_delivery[0].name
    "meter-reconciliation-lag" = google_monitoring_slo.billing_meter_reconciliation_lag[0].name
  } : {}
  billing_burn_alerts = {
    for pair in setproduct(keys(local.billing_slo_ids), keys(local.burn_rate_thresholds)) :
    "${pair[0]}-${pair[1]}" => {
      slo_key  = pair[0]
      burn_key = pair[1]
    }
  }
}

resource "google_monitoring_alert_policy" "billing_burn_rate" {
  for_each = local.billing_burn_alerts

  project      = var.project_id
  display_name = "Billing SLO burn — ${each.value.slo_key} ${each.value.burn_key}"
  combiner     = "OR"

  conditions {
    display_name = "burn-rate-${each.value.burn_key}"
    condition_threshold {
      filter          = <<-EOT
        select_slo_burn_rate("${local.billing_slo_ids[each.value.slo_key]}", "${local.burn_rate_thresholds[each.value.burn_key].lookback}")
      EOT
      comparison      = "COMPARISON_GT"
      threshold_value = local.burn_rate_thresholds[each.value.burn_key].threshold
      duration        = "300s"
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = "SLO ${each.value.slo_key} is burning at >${local.burn_rate_thresholds[each.value.burn_key].threshold}x over ${local.burn_rate_thresholds[each.value.burn_key].lookback}. Runbook: docs/runbooks/SLO-${each.value.slo_key}.md"
    mime_type = "text/markdown"
  }
}
