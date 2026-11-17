# R5 Cloud Scheduler jobs required by the plan.
# These live alongside the existing tenant-runtime resources; they are
# per-tenant jobs that invoke internal HTTP endpoints with OIDC auth.

# Set to true after agent-service (the tenant-runtime-image Cloud Run service
# with SERVICE_TYPE=agent) is first deployed by Cloud Build. On initial apply
# of a new environment this must be false (the service doesn't exist yet).
# After the first deploy, set to true and re-apply to create the scheduler
# jobs.
variable "tenant_runtime_deployed" {
  description = "True after agent-service Cloud Run service is deployed. Gates scheduler job creation."
  type        = bool
  default     = false
}

# Idle cadence: every job that fires more than hourly (its minute field is
# "*" or "*/N") fires once an hour instead, all at :00, together with the DLQ
# drainers and the sandbox GC sweep. agent-service and sandbox-executor bill
# always-on CPU for as long as an instance is up, and a request at least every
# 15 minutes keeps one up forever, so at the live cadence an environment with
# no traffic paid for 4 vCPU around the clock. At :00 they share one wake an
# hour. The cost is latency on the sweeps and reconcilers (a stalled run is
# noticed within the hour, not ten minutes). Set false once there is traffic.
#
# Jobs that already fire hourly or less often move to minute 0 of the hour they
# fire in ("5 * * * *" → "0 * * * *", "20 3 * * *" → "0 3 * * *"): a job at :05
# lands after the :00 wake has started and keeps agent-service up until :20
# instead of :15, every hour, and a daily job at :20 or :40 is a wake of its own.
variable "idle_cadence" {
  description = "Run every sub-hourly scheduler job hourly at :00 so idle services can scale to zero."
  type        = bool
  default     = false
}

locals {
  idle_schedule = "0 * * * *"
}

# Data source for agent-service, the public-ingress split service that mounts
# the `/internal/*` reaper endpoints these scheduler jobs invoke. Deployed by
# Cloud Build (not Terraform), so we look it up here rather than managing it
# as a module. The `tenant-runtime` monolith deployment that this used to
# reference has been decommissioned.
data "google_cloud_run_v2_service" "tenant_runtime" {
  count    = var.tenant_runtime_deployed ? 1 : 0
  name     = "agent-service"
  project  = google_project.tenant_runtime.project_id
  location = var.region
}

locals {
  # One job. Every maintenance endpoint on agent-service used to have its own
  # entry here, and each woke agent-service at the top of every hour whether or
  # not there was work: two thirds of the service's bill was the clock. The
  # runtime now arms a Cloud Task for an endpoint when its work appears (a run
  # starting, a session opening, a claim, a failed publish; see the runtime's
  # src/infrastructure/maintenance-tasks.ts), and this one job runs every
  # endpoint once a day as the backstop and as the cadence for retention,
  # reconcilers and probes (DAILY_HOUSEKEEPING in src/handlers/housekeeping.ts).
  # 15:00 UTC is the hour platform-backend's daily pass runs, which calls into
  # this runtime too, so the two share one wake.
  r5_scheduler_jobs = {
    "housekeeping-daily" = {
      schedule    = "0 15 * * *"
      uri_path    = "/api/internal/housekeeping/daily"
      description = "Daily maintenance pass: enqueues every maintenance endpoint as a Cloud Task (backstop + cadence)"
    }
  }
}

# NO engine-certification schedule, deliberately.
#
# The suite splits into two kinds of check and only one of them is time-shaped:
#
#   Our own contract surface — invocation/termination, governed tool execution,
#   HITL, usage, sessions, trajectory fidelity — already runs at level 1 on
#   every PR against mocked transports, plus the per-adapter fixture suites.
#   Re-running it on a calendar re-tests code that did not change.
#
#   The vendor's behaviour — `sdk_hook_contract`. This is the one a schedule
#   could plausibly buy, and it does not, because the SDK is pinned to an EXACT
#   version (asserted by a test, not a convention) and the CLI ships inside that
#   package. The hook semantics live in the pinned artifact, so a weekly run
#   measures a constant.
#
# What actually invalidates the vendor contract is BUMPING THE PIN, which is a
# pull request rather than a Monday. A scheduler here was reaching for a
# calendar because the job had no trigger — but "nothing invokes this" was the
# symptom, and a calendar is not a trigger, it is a way of not choosing one.
#
# The job itself still exists (Cloud Build creates it on every deploy) and is
# run by hand or by CI when the pin moves.

# Watch the schedulers themselves.
#
# A Cloud Scheduler job reports ENABLED whether or not it has ever succeeded.
# Whether an attempt worked lives in its execution log, which no dashboard
# shows — so a job can sit enabled and failing for months, never having
# succeeded once. The two common causes are invisible for exactly this reason:
# a scheduler service account with no run.invoker (403 forever) and a target
# path the app does not mount (404 forever).
#
# NOT the built-in cloudscheduler.googleapis.com/job/attempt_count metric. It is
# documented, but no descriptor for it resolves in this project, so an alert
# policy referencing it fails to create with a 404 on the metric type. The
# execution log is what these projects actually have, and its shape is taken
# from real failing entries rather than from documentation: severity ERROR,
# jsonPayload.status carrying the gRPC status name ("NOT_FOUND",
# "PERMISSION_DENIED", "INVALID_ARGUMENT"), and resource.labels.job_id naming
# the job.
#
# One entry is emitted per failed attempt for every job in the project, so this
# covers each entry in r5_scheduler_jobs including ones added later, and it
# fires for a job whose handler never runs at all.
resource "google_logging_metric" "scheduler_job_failed" {
  project     = google_project.tenant_runtime.project_id
  name        = "scheduler_job_failed"
  description = "One per FAILED Cloud Scheduler attempt. A job reports ENABLED whether or not it has ever succeeded, so this counter is the only thing that distinguishes a working schedule from a decorative one."
  filter      = "resource.type=\"cloud_scheduler_job\" AND severity>=ERROR"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "job_id"
      value_type  = "STRING"
      description = "The Cloud Scheduler job that failed"
    }
    labels {
      key         = "status"
      value_type  = "STRING"
      description = "gRPC status name for the attempt: NOT_FOUND (path not mounted), PERMISSION_DENIED (no run.invoker), UNAUTHENTICATED, INVALID_ARGUMENT, UNKNOWN (target 5xx)"
    }
  }

  label_extractors = {
    "job_id" = "EXTRACT(resource.labels.job_id)"
    "status" = "EXTRACT(jsonPayload.status)"
  }
}

resource "google_monitoring_alert_policy" "r5_scheduler_job_failing" {
  project      = google_project.tenant_runtime.project_id
  display_name = "Cloud Scheduler job failing — ${var.environment}"
  combiner     = "OR"
  # Without a channel an alert fires into nothing, which is the same blind spot
  # in a different place.
  notification_channels = local.alert_notification_channels

  conditions {
    display_name = "A scheduler job attempt failed"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/scheduler_job_failed\" AND resource.type=\"cloud_scheduler_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      # An hour, not an instant: retry_config gives each job three attempts with
      # backoff, so a transient failure the retry then fixes must not page. A job
      # still failing an hour later is failing.
      duration = "3600s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["metric.label.job_id", "metric.label.status"]
      }
    }
  }

  documentation {
    content = <<-EOT
      A Cloud Scheduler job in this tenant project has been failing for an hour.
      The job still shows ENABLED; that field says nothing about whether it works.

      Which job, and why, are in the alert labels: job_id and status. The full
      entry is in Logging under resource.type="cloud_scheduler_job" with
      severity ERROR, where httpRequest.status carries the HTTP code.

      NOT_FOUND (404) — the target path is not mounted. The convention on
      agent-service is /api/internal/*, and a job pointed at bare /internal/*
      404s forever. Confirm the route exists in the DEPLOYED revision, not only
      on main.

      PERMISSION_DENIED (403) — the scheduler's OIDC service account has no
      roles/run.invoker on the target service. The single most common cause in
      this estate.

      UNAUTHENTICATED (401) — the endpoint expects a shared secret and the
      scheduler sends only an OIDC token. The r5 jobs send OIDC and no header,
      so their handlers must not sit behind requireServiceAuth().

      UNKNOWN / 5xx — the handler itself is throwing. Read the service logs for
      that path around the attempt timestamps.

      Do not resolve this by pausing the job. A paused job stops firing and
      stops alerting, which reproduces the original blind spot deliberately.
    EOT
  }

  alert_strategy { auto_close = "604800s" }

  # A freshly created log-based metric can take a few minutes to become
  # queryable, and the alert policy is rejected with a 404 on the metric type
  # until it is. depends_on orders the create but cannot wait out the
  # propagation, so the first apply after adding a metric may fail here and
  # succeed on a re-run. That is the same behaviour as the other log-metric
  # alerts in this project, not a fault in this one.
  depends_on = [google_logging_metric.scheduler_job_failed]
}

# Watch the maintenance Cloud Tasks the same way.
#
# The runtime's maintenance no longer runs on Cloud Scheduler: it is armed as a
# Cloud Task on <tenant>-maintenance-tasks-<env>-v2 when the work appears, and
# housekeeping-daily above enqueues the rest. A task that fails is the same
# "enabled but never works" fact as a failing scheduler job, one layer down.
# Shape of a failed attempt: severity ERROR on
# cloudtasks.googleapis.com/task_operations_log with
# jsonPayload.attemptResponseLog.status. The task name's prefix
# (hk-<date>- / watch- / due-) and numeric suffix are stripped so the label is
# the kind of work.
resource "google_logging_metric" "maintenance_task_attempt_failed" {
  project     = google_project.tenant_runtime.project_id
  name        = "maintenance_task_attempt_failed"
  description = "One per FAILED attempt of a maintenance Cloud Task."
  filter      = <<-EOT
    resource.type="cloud_tasks_queue"
    AND resource.labels.queue_id="${var.tenant_id}-maintenance-tasks-${var.environment}-v2"
    AND severity=ERROR
    AND jsonPayload.attemptResponseLog.status:*
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "kind"
      value_type  = "STRING"
      description = "The maintenance work: an endpoint path for a daily-pass task, else the armed kind"
    }
    labels {
      key         = "status"
      value_type  = "STRING"
      description = "gRPC status of the attempt"
    }
  }

  label_extractors = {
    "kind"   = "REGEXP_EXTRACT(jsonPayload.task, \"/tasks/(?:hk-[0-9]{8}-|watch-|due-)?(.+?)(?:-[0-9]+)?$\")"
    "status" = "EXTRACT(jsonPayload.attemptResponseLog.status)"
  }
}

resource "google_monitoring_alert_policy" "maintenance_task_failed" {
  project               = google_project.tenant_runtime.project_id
  display_name          = "Maintenance task failing — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels

  # Three attempts with backoff per task: a failure the retry fixes must not
  # page; three of the same kind in six hours is a task the queue gave up on.
  conditions {
    display_name = "A maintenance task failed three times"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/maintenance_task_attempt_failed\" AND resource.type=\"cloud_tasks_queue\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2
      duration        = "0s"
      aggregations {
        alignment_period     = "21600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.kind"]
      }
    }
  }

  documentation {
    content = <<-EOT
      A maintenance Cloud Task in this tenant project failed three times; the kind label names the work. NOT_FOUND is a path the deployed revision does not mount; PERMISSION_DENIED is the scheduler SA lacking run.invoker on the target (agent-service or sandbox-executor); UNKNOWN is the handler throwing — read the service logs for that path. Attempts: resource.type="cloud_tasks_queue" severity=ERROR.
    EOT
  }

  alert_strategy { auto_close = "604800s" }

  depends_on = [google_logging_metric.maintenance_task_attempt_failed]
}

# R5 Fix 8: automated 90-day framer-secret rotation.
#
# The rotation happens in-place without human intervention:
#   1. Cloud Scheduler fires every 90 days
#   2. Invokes the `framer-secret-rotate` Cloud Run Job with OIDC auth
#   3. The job generates 32 bytes of crypto-random, adds a new secret version,
#      disables the N-2 version (keeping N and N-1 for rollback safety)
#   4. Cloud Run services pick up the new version at next cold start; running
#      revisions continue on the cached prior version until they restart
#
# No pager/runbook action required in the common case. The manual runbook at
# docs/runbooks/framer-secret-rotation.md covers emergency rotation (suspected
# compromise) where we need to disable the old version immediately rather than
# waiting for the 24h bake window.

# Skip job creation until the rotator image is published to Artifact Registry.
# Set var.framer_rotator_image (or let platform-ci build it) to enable.
variable "framer_rotator_image" {
  description = "R5 Fix 8: full image ref for the framer-secret-rotate Cloud Run Job. Empty disables job + scheduler creation (apply later when image is published)."
  type        = string
  default     = ""
}

resource "google_cloud_run_v2_job" "framer_secret_rotate" {
  count    = var.framer_rotator_image != "" ? 1 : 0
  name     = "framer-secret-rotate"
  project  = google_project.tenant_runtime.project_id
  location = var.region

  template {
    template {
      service_account = google_service_account.framer_rotator.email
      max_retries     = 3
      timeout         = "300s"

      containers {
        # Small image with gcloud SDK + openssl. Published by platform CI.
        image = var.framer_rotator_image

        env {
          name  = "SECRET_NAME"
          value = google_secret_manager_secret.framer_secret.id
        }
        env {
          name  = "GCP_PROJECT"
          value = google_project.tenant_runtime.project_id
        }
        env {
          name  = "KEEP_VERSIONS"
          value = "2" # keep N and N-1; disable N-2 and older
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

  depends_on = [
    google_project_service.apis,
    google_secret_manager_secret.framer_secret,
  ]

  lifecycle {
    ignore_changes = [
      # The image is pinned by the service's cloudbuild on every deploy (the
      # freshly built image), not by Terraform: a digest held in tfvars is
      # deleted by the Docker registry's 30-day cleanup as soon as its service
      # has deployed a few times, and the job then fails "image not found" on
      # its next run. The tfvars
      # digest is only the image a NEW job starts from.
      template[0].template[0].containers[0].image,
    ]
  }
}

# Dedicated SA for the rotation job — principle of least privilege.
resource "google_service_account" "framer_rotator" {
  account_id   = "framer-rotator"
  display_name = "R5 framer-secret rotator"
  project      = google_project.tenant_runtime.project_id
  description  = "Service account for the framer-secret-rotate Cloud Run Job"
}

# Rotator SA needs: addVersion + disable on the specific secret only.
resource "google_secret_manager_secret_iam_member" "framer_rotator_add_version" {
  secret_id = google_secret_manager_secret.framer_secret.id
  project   = google_project.tenant_runtime.project_id
  role      = "roles/secretmanager.secretVersionAdder"
  member    = "serviceAccount:${google_service_account.framer_rotator.email}"
}

resource "google_secret_manager_secret_iam_member" "framer_rotator_manage_versions" {
  secret_id = google_secret_manager_secret.framer_secret.id
  project   = google_project.tenant_runtime.project_id
  role      = "roles/secretmanager.secretVersionManager" # enable/disable/destroy versions
  member    = "serviceAccount:${google_service_account.framer_rotator.email}"
}

# Scheduler invokes the rotation job every 90 days.
resource "google_cloud_scheduler_job" "r5_framer_secret_rotate" {
  count       = var.framer_rotator_image != "" ? 1 : 0
  name        = "r5-framer-secret-rotate"
  project     = google_project.tenant_runtime.project_id
  region      = var.region
  schedule    = "0 10 1 */3 *" # Every 3 months, 1st of month, 10:00 UTC
  description = "R5 Fix 8: automated framer-secret rotation (90-day cadence)"
  time_zone   = "UTC"

  retry_config {
    retry_count          = 3
    min_backoff_duration = "300s"
    max_backoff_duration = "3600s"
  }

  http_target {
    http_method = "POST"
    uri = format(
      "https://%s-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/%s/jobs/%s:run",
      var.region,
      google_project.tenant_runtime.project_id,
      google_cloud_run_v2_job.framer_secret_rotate[0].name,
    )

    oauth_token {
      service_account_email = google_service_account.framer_rotator.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_cloud_run_v2_job.framer_secret_rotate[0]]
}

# Alert: page on rotation job failure.
# GCP alert policies cap `duration` at 24h30m, so the "93-day overdue" check
# can't be expressed natively. Instead, we alert on EXECUTION FAILURE — if the
# scheduled rotation fires and the job fails, we get paged. Additionally,
# Cloud Scheduler itself has built-in monitoring for missed executions that
# pages if the scheduler stops firing. Combined, these cover:
#   - Rotation ran but job failed → this alert
#   - Scheduler didn't fire → Cloud Scheduler native monitoring
resource "google_monitoring_alert_policy" "framer_rotation_job_failed" {
  count        = var.framer_rotator_image != "" ? 1 : 0
  project      = google_project.tenant_runtime.project_id
  display_name = "R5 framer-secret rotation job failed"
  combiner     = "OR"

  conditions {
    display_name = "framer-secret-rotate failed execution"
    condition_threshold {
      filter          = <<-EOT
        resource.type="cloud_run_job"
        AND resource.labels.job_name="framer-secret-rotate"
        AND metric.type="run.googleapis.com/job/completed_execution_count"
        AND metric.labels.result="failed"
      EOT
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  severity = "WARNING"
}

# How long Cloud Scheduler waits for a job before calling the attempt failed.
#
# The default is 180s, which is right for the polling and sweep endpoints above
# — they answer in seconds. It is wrong for a job that does bulk work: exceeding
# the deadline does not stop the request, it marks the attempt failed and lets
# retry_config fire another one while the first is still running on the service.
# Two copies of a batch sweep then contend over the same rows.
#
# A value here must also stay within the target service's own request timeout
# (agent-service allows 900s); past that the scheduler would be waiting on a
# request the platform has already killed.
#
# Listed per job rather than added to every entry in the map above, so the map
# keeps one shape and only the exceptions have to be stated.
locals {
  r5_default_attempt_deadline = "180s"

  r5_job_attempt_deadlines = {
    # Deletes superseded agent_skills in bounded batches, then rebuilds the HNSW
    # index once the tail drains. A large initial backlog can take minutes;
    # steady state is seconds, but the headroom is what keeps a
    # rebuilt backlog from being retried on top of itself.
    "agent-skills-retention" = "900s"
  }
}

resource "google_cloud_scheduler_job" "r5_jobs" {
  for_each = var.tenant_runtime_deployed ? local.r5_scheduler_jobs : {}

  name    = each.key
  project = google_project.tenant_runtime.project_id
  region  = var.region
  schedule = (
    !var.idle_cadence ? each.value.schedule :
    startswith(each.value.schedule, "*") ? local.idle_schedule :
    "0 ${join(" ", slice(split(" ", each.value.schedule), 1, 5))}"
  )
  description      = each.value.description
  time_zone        = "UTC"
  attempt_deadline = lookup(local.r5_job_attempt_deadlines, each.key, local.r5_default_attempt_deadline)

  retry_config {
    retry_count          = 3
    min_backoff_duration = "30s"
    max_backoff_duration = "600s"
  }

  http_target {
    http_method = "POST"
    uri         = "${data.google_cloud_run_v2_service.tenant_runtime[0].uri}${each.value.uri_path}"

    oidc_token {
      service_account_email = "tenant-${var.tenant_id}-runtime@tenant-${var.tenant_id}-${var.environment}.iam.gserviceaccount.com"
      audience              = data.google_cloud_run_v2_service.tenant_runtime[0].uri
    }
  }

  depends_on = [google_project_service.cloudscheduler]
}
