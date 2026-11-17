// Quarterly sandbox cost calibration.
// Provisions:
//   - service account with billing-viewer + run-admin + token-creator
//   - Cloud Run Job that runs scripts/calibrate-sandbox-credits.ts
//   - Cloud Scheduler job firing the calibration job on the 1st of every 3rd month
//
// Output is written to scripts/calibration-results/${YYYY-MM-DD}.json; if any
// operation's measured cost drifts >10% from credit-calculator.ts, the job
// opens a PR bumping the values (see scripts/calibrate-sandbox-credits.ts).

variable "sandbox_calibration_enabled" {
  type        = bool
  default     = false
  description = "Enable the quarterly sandbox cost calibration Cloud Scheduler job. Defaults to false; enable per tenant after the script has run successfully in a non-production environment."
}

variable "sandbox_calibration_image" {
  type        = string
  default     = ""
  description = "Image URI for the calibration job. Empty = derived from var.sandbox_sidecar_image registry path with tag 'latest'."
}

resource "google_service_account" "calibration" {
  count        = var.sandbox_calibration_enabled ? 1 : 0
  project      = google_project.tenant_runtime.project_id
  account_id   = "sandbox-calibration"
  display_name = "Sandbox cost calibration job"
}

resource "google_project_iam_member" "calibration_run_admin" {
  count   = var.sandbox_calibration_enabled ? 1 : 0
  project = google_project.tenant_runtime.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.calibration[0].email}"
}

resource "google_project_iam_member" "calibration_billing_viewer" {
  count   = var.sandbox_calibration_enabled ? 1 : 0
  project = google_project.tenant_runtime.project_id
  role    = "roles/billing.viewer"
  member  = "serviceAccount:${google_service_account.calibration[0].email}"
}

resource "google_service_account_iam_member" "calibration_token_creator" {
  count              = var.sandbox_calibration_enabled ? 1 : 0
  service_account_id = google_service_account.calibration[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.calibration[0].email}"
}

resource "google_cloud_run_v2_job" "calibrate" {
  count    = var.sandbox_calibration_enabled ? 1 : 0
  project  = google_project.tenant_runtime.project_id
  name     = "sandbox-cost-calibrate"
  location = var.region

  template {
    template {
      service_account = google_service_account.calibration[0].email
      max_retries     = 0
      timeout         = "3900s" # 65 minutes for billing pipeline + workload

      containers {
        image   = var.sandbox_calibration_image != "" ? var.sandbox_calibration_image : "${local.sandbox_image_registry}/aio-sandbox:${var.aio_sandbox_image_tag}"
        command = ["node"]
        args    = ["dist/scripts/calibrate-sandbox-credits.js"]

        resources {
          limits = {
            cpu    = "2"
            memory = "4Gi"
          }
        }

        env {
          name  = "GCP_PROJECT_ID"
          value = google_project.tenant_runtime.project_id
        }
        env {
          name  = "GCP_REGION"
          value = var.region
        }
        env {
          name  = "AIO_SANDBOX_IMAGE_TAG"
          value = var.aio_sandbox_image_tag
        }
        env {
          name  = "BILLING_ACCOUNT_ID"
          value = var.billing_account_id
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
}

resource "google_cloud_scheduler_job" "sandbox_calibrate" {
  count     = var.sandbox_calibration_enabled ? 1 : 0
  project   = google_project.tenant_runtime.project_id
  region    = var.region
  name      = "sandbox-cost-calibrate"
  schedule  = "0 0 1 */3 *" // 00:00 on the 1st of every 3rd month
  time_zone = "UTC"

  http_target {
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.tenant_runtime.project_id}/jobs/${google_cloud_run_v2_job.calibrate[0].name}:run"
    http_method = "POST"

    oauth_token {
      service_account_email = google_service_account.calibration[0].email
    }
  }
}

variable "billing_account_id" {
  type        = string
  default     = ""
  description = "Billing account ID used by the calibration job's Cloud Billing API query. Required when sandbox_calibration_enabled = true."
}
