# NOTE: cost-attribution-ingest-runner is NOT defined here.
#
# The original plan (§2.3) asked to update an existing Cloud Scheduler job's
# cadence from */15 to */5 minutes. That job already runs in each control
# project (managed outside this Terraform module). Defining it here would
# either (a) collide with the live resource on apply, or (b) create a second
# scheduler that double-fires ingestion.
#
# Operator action required after deploying this module:
#
#   gcloud scheduler jobs update http cost-attribution-ingest-runner \
#     --project=YOUR_GCP_PROJECT \
#     --schedule="*/5 * * * *" \
#     --uri="${PB_URL}/api/internal/jobs/cost-attribution-ingest" \
#     --http-method=POST \
#     --update-headers="X-Service-Auth=${PLATFORM_CALLBACK_TOKEN},Content-Type=application/json"
#
# The uri MUST point at /api/internal/jobs/cost-attribution-ingest (service-
# auth-gated via webToolsJobsRouter) rather than /api/cost-attribution/internal/
# ingest (behind authMiddleware → 401 for X-Service-Auth callers).

# Schedulers below mirror the existing convention in
# projects/platform-control/main.tf (expire-agent-messages and friends):
#   - X-Service-Auth header for app-layer validation (validateServiceAuth)
#   - oidc_token block for Cloud Run IAM (the target service is deployed
#     with --no-allow-unauthenticated; without OIDC the request never
#     reaches the app and the X-Service-Auth check never runs)

resource "google_cloud_scheduler_job" "vendor_reconciliation" {
  name             = "vendor-reconciliation"
  schedule         = "0 6 1 * *" # 06:00 UTC on the 1st of each month
  time_zone        = "UTC"
  attempt_deadline = "120s"
  region           = "us-west1"
  project          = var.platform_control_project
  http_target {
    http_method = "POST"
    uri         = "${var.platform_backend_url}/api/internal/jobs/vendor-reconciliation"
    headers = {
      "X-Service-Auth" = var.platform_callback_token
      "Content-Type"   = "application/json"
    }
    body = base64encode("{}")
    oidc_token {
      service_account_email = var.platform_control_scheduler_sa
      audience              = var.platform_backend_url
    }
  }
}

resource "google_cloud_scheduler_job" "web_sessions_reap" {
  name             = "web-sessions-reap"
  schedule         = "*/5 * * * *"
  time_zone        = "UTC"
  attempt_deadline = "120s"
  region           = "us-west1"
  project          = var.tenant_runtime_project

  http_target {
    http_method = "POST"
    uri         = "${var.tenant_runtime_url}/api/jobs/web-sessions-reap"
    headers = {
      "X-Service-Auth" = var.platform_callback_token
      "Content-Type"   = "application/json"
    }
    body = base64encode("{}")
    oidc_token {
      service_account_email = var.tenant_runtime_scheduler_sa
      audience              = var.tenant_runtime_url
    }
  }
}

resource "google_cloud_scheduler_job" "anchor_quota_poll" {
  name             = "anchor-quota-poll"
  schedule         = "*/5 * * * *"
  time_zone        = "UTC"
  attempt_deadline = "60s"
  region           = "us-west1"
  project          = var.tenant_runtime_project
  http_target {
    http_method = "POST"
    uri         = "${var.tenant_runtime_url}/api/jobs/anchor-quota-poll"
    headers = {
      "X-Service-Auth" = var.platform_callback_token
      "Content-Type"   = "application/json"
    }
    body = base64encode("{}")
    oidc_token {
      service_account_email = var.tenant_runtime_scheduler_sa
      audience              = var.tenant_runtime_url
    }
  }
}

resource "google_cloud_scheduler_job" "firecrawl_quota_poll" {
  name             = "firecrawl-quota-poll"
  schedule         = "*/5 * * * *"
  time_zone        = "UTC"
  attempt_deadline = "60s"
  region           = "us-west1"
  project          = var.tenant_runtime_project
  http_target {
    http_method = "POST"
    uri         = "${var.tenant_runtime_url}/api/jobs/firecrawl-quota-poll"
    headers = {
      "X-Service-Auth" = var.platform_callback_token
      "Content-Type"   = "application/json"
    }
    body = base64encode("{}")
    oidc_token {
      service_account_email = var.tenant_runtime_scheduler_sa
      audience              = var.tenant_runtime_url
    }
  }
}

resource "google_cloud_scheduler_job" "tavily_quota_poll" {
  name             = "tavily-quota-poll"
  schedule         = "*/5 * * * *"
  time_zone        = "UTC"
  attempt_deadline = "60s"
  region           = "us-west1"
  project          = var.tenant_runtime_project
  http_target {
    http_method = "POST"
    uri         = "${var.tenant_runtime_url}/api/jobs/tavily-quota-poll"
    headers = {
      "X-Service-Auth" = var.platform_callback_token
      "Content-Type"   = "application/json"
    }
    body = base64encode("{}")
    oidc_token {
      service_account_email = var.tenant_runtime_scheduler_sa
      audience              = var.tenant_runtime_url
    }
  }
}

resource "google_cloud_scheduler_job" "vendor_spend_monitor" {
  name             = "vendor-spend-monitor"
  schedule         = "0 12 * * *"
  time_zone        = "UTC"
  attempt_deadline = "120s"
  region           = "us-west1"
  project          = var.platform_control_project
  http_target {
    http_method = "POST"
    uri         = "${var.platform_backend_url}/api/internal/jobs/vendor-spend-monitor"
    headers = {
      "X-Service-Auth" = var.platform_callback_token
      "Content-Type"   = "application/json"
    }
    body = base64encode("{}")
    oidc_token {
      service_account_email = var.platform_control_scheduler_sa
      audience              = var.platform_backend_url
    }
  }
}
