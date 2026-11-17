# Engine live-certification canary.
#
# The engine-certification Cloud Run Job (`tenant-runtime-engine-certification`,
# created per-tenant by the tenant-runtime cloudbuild) runs
# dist/scripts/certify-engines.js — the LIVE (level 3) certification: real
# provider/SDK calls that DRIVE EVERY engine's adapter and assert the §7.2
# behaviors, then emit a per-engine `engine_live_certification` result log. It
# certifies ALL engines (the platform is provider-switchable — every engine must
# be proven live-ready, not just the active one); an engine that cannot
# authenticate/construct in this env fails closed and is surfaced by engine.
#
# This provisions the scheduler that fires it on a cadence, plus a log-based
# metric + alert, so a live-cert regression (any engine's SDK/CLI/image no longer
# honoring the contract, or an engine not yet provisioned) is visible before that
# engine is trusted/promoted.
#
# Cost-gated, DEFAULT OFF (real LLM calls): flip per env once the job has run
# cleanly in dev, mirroring sandbox_calibration_enabled.

variable "engine_certification_scheduled" {
  type        = bool
  default     = false
  description = "Enable the scheduled engine live-certification canary (real provider calls). Default false; enable per environment after the job runs cleanly in a non-production environment."
}

locals {
  engine_cert_on = var.engine_certification_scheduled
}

resource "google_service_account" "engine_cert_scheduler" {
  count        = local.engine_cert_on ? 1 : 0
  project      = google_project.tenant_runtime.project_id
  account_id   = "engine-cert-sched"
  display_name = "Engine live-certification canary scheduler"
}

resource "google_project_iam_member" "engine_cert_scheduler_run_developer" {
  count   = local.engine_cert_on ? 1 : 0
  project = google_project.tenant_runtime.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.engine_cert_scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "engine_certification" {
  count     = local.engine_cert_on ? 1 : 0
  project   = google_project.tenant_runtime.project_id
  region    = var.region
  name      = "engine-certification-canary"
  schedule  = "0 6 * * *" # daily 06:00 UTC
  time_zone = "UTC"

  http_target {
    uri         = "https://run.googleapis.com/v2/projects/${google_project.tenant_runtime.project_id}/locations/${var.region}/jobs/tenant-runtime-engine-certification:run"
    http_method = "POST"
    headers     = { "Content-Type" = "application/json" }
    oauth_token {
      service_account_email = google_service_account.engine_cert_scheduler[0].email
    }
  }
}

# Result metric (from the per-engine result log the script emits). Always defined
# so a manual job run is captured even while the scheduler is off; costs nothing
# when no matching logs exist.
resource "google_logging_metric" "engine_live_certification" {
  project     = google_project.tenant_runtime.project_id
  name        = "engine_live_certification"
  description = "Live engine-certification results (real provider calls), one point per engine per run, sliced by engine + pass/fail outcome."
  filter      = "jsonPayload.metric_name = \"engine_live_certification\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "execution_engine"
      value_type  = "STRING"
      description = "The engine that was live-certified."
    }
    labels {
      key         = "outcome"
      value_type  = "STRING"
      description = "passed | failed"
    }
  }
  label_extractors = {
    "execution_engine" = "EXTRACT(jsonPayload.execution_engine)"
    "outcome"          = "EXTRACT(jsonPayload.outcome)"
  }
}

# A newly-created log-based metric's descriptor needs a few minutes to register
# before an alert can filter on its labels; gate the alert behind a short sleep
# (the codebase's wait_*_metric pattern).
resource "time_sleep" "wait_engine_live_certification_metric" {
  count           = local.engine_cert_on ? 1 : 0
  depends_on      = [google_logging_metric.engine_live_certification]
  create_duration = "60s"
}

resource "google_monitoring_alert_policy" "engine_live_certification_failed" {
  count        = local.engine_cert_on ? 1 : 0
  depends_on   = [time_sleep.wait_engine_live_certification_metric]
  project      = google_project.tenant_runtime.project_id
  display_name = "Engine live-certification FAILED"
  combiner     = "OR"

  documentation {
    content = "An ENABLED engine failed live certification: real provider/SDK/CLI calls no longer honor the §7.2 behavioral contract (one terminal event / usage / no-stub-success / resume). Do not trust or promote that engine's image. Inspect the engine-certification-canary Cloud Run Job logs for the engine_live_certification result with outcome=failed + its failed_checks."
  }

  conditions {
    display_name = "live-cert failures > 0"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.engine_live_certification.name}\" AND metric.label.outcome = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}
