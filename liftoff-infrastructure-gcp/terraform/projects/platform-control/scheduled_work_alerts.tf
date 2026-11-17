# Health signal for scheduled work.
#
# A Cloud Scheduler job can sit in a failed state while reporting ENABLED. Its
# failure lives in its `status.code` field, which no dashboard surfaces, so
# without these alerts work like the following can silently never execute:
#
#   - the billing 7-year audit retention sweep (PERMISSION_DENIED)
#   - partition maintenance jobs (PERMISSION_DENIED)
#   - GDPR retention cleanup (NOT_FOUND — wrong URL)
#
# and one job can have several independent defects stacked behind that
# silence, each hidden by the one in front of it.
#
# Three signals, deliberately overlapping, because each catches what the others
# cannot:
#   1. the scheduler could not invoke the target at all      (never runs)
#   2. the job ran and exited non-zero                        (runs, fails)
#   3. a partitioned table rejected an insert                 (runs, succeeds,
#                                                              but too late)

locals {
  # gRPC statuses that Cloud Scheduler retries and usually recovers from within
  # the same second. Anything NOT in this set is a configuration defect that
  # will never fix itself.
  transient_scheduler_statuses = "UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED|RESOURCE_EXHAUSTED|ABORTED"

  # Interactive and one-off jobs. This alert's own documentation says these are
  # jobs "none of them has a user watching" — but the estate runs ad-hoc psql
  # and probe jobs through the same Cloud Run Jobs API, and a mistyped SQL
  # query in one of them is a failed execution by this metric's definition. In
  # the 7 days before this was written, prod's top two "failures" were
  # platform-backend-psql (12) and tenant-runtime-psql (10), both of them a
  # human at a keyboard getting a syntax error back — one of which paged at
  # 00:38. Ad-hoc work must be named to match one of these suffixes.
  ad_hoc_job_name_pattern = ".*-psql|.*-oneoff|.*-query|.*probe.*"
}

# ── 1. Scheduler could not invoke its target ────────────────────────────────
#
# Cloud Scheduler logs every attempt to cloudscheduler.googleapis.com/executions
# and marks failures severity=ERROR with jsonPayload.status carrying the gRPC
# status name (PERMISSION_DENIED, NOT_FOUND, INVALID_ARGUMENT, ...). This is the
# one signal that would have caught every scheduler defect found in the audit.
resource "google_logging_metric" "scheduler_execution_failed" {
  project = google_project.platform_control.project_id
  name    = "scheduler-execution-failed-${var.environment}"
  filter  = <<-EOT
    resource.type="cloud_scheduler_job"
    AND severity=ERROR
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "job_id"
      value_type  = "STRING"
      description = "Cloud Scheduler job that failed to invoke its target"
    }
    labels {
      key         = "status"
      value_type  = "STRING"
      description = "gRPC status name, e.g. PERMISSION_DENIED or NOT_FOUND"
    }
  }

  label_extractors = {
    "job_id" = "EXTRACT(resource.labels.job_id)"
    "status" = "EXTRACT(jsonPayload.status)"
  }
}

# A log-based metric is not addressable by Monitoring the instant Logging
# accepts it, and an alert policy that references one too early fails the apply
# with "Cannot find metric(s) that match type = ...". depends_on orders the
# creates but does nothing about propagation, so the first apply on a green-field
# project fails and the second succeeds — which is precisely the kind of
# only-fails-once-so-nobody-fixes-it behaviour this file exists to end. Same
# treatment the pubsub_push IAM race gets in tenant-runtime-template.
resource "time_sleep" "log_metrics_propagate" {
  depends_on = [
    google_logging_metric.scheduler_execution_failed,
    google_logging_metric.maintenance_task_attempt_failed,
    google_logging_metric.partition_overflow,
  ]
  create_duration = "120s"
}

resource "google_monitoring_alert_policy" "scheduler_execution_failed" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Scheduled work: scheduler could not invoke its target (${var.environment})"
  combiner     = "OR"

  # Split by status class. A single zero-threshold condition pages on every
  # status equally, which is self-defeating: a transient UNAVAILABLE, retried
  # and succeeded a moment later, wakes a human, while chronic real breakage
  # (INVALID_ARGUMENT, UNAUTHENTICATED, PERMISSION_DENIED, NOT_FOUND) opens its
  # incident once and then sits silent, because Monitoring does not re-notify
  # an already-open incident.
  #
  # So: hard statuses keep the zero threshold, transient ones need to be
  # sustained before they page.
  conditions {
    display_name = "scheduler could not invoke its target — hard failure (1 hour)"
    condition_threshold {
      filter          = "resource.type=\"cloud_scheduler_job\" AND metric.type=\"logging.googleapis.com/user/scheduler-execution-failed-${var.environment}\" AND NOT metric.label.status=monitoring.regex.full_match(\"${local.transient_scheduler_statuses}\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.job_id", "metric.label.status"]
      }
    }
  }

  # Threshold is zero on purpose for the condition above. A scheduler that
  # cannot invoke its target for a config reason is never noise: it means the
  # work is simply not happening, and the only other place that shows is a
  # status field nobody reads.

  # Cloud Scheduler retries immediately and the retry almost always wins, so a
  # single UNAVAILABLE is a Google-side blip, not an outage. Five in one hour
  # is a real inability to reach the API and still pages.
  conditions {
    display_name = "scheduler could not invoke its target — transient, sustained (1 hour)"
    condition_threshold {
      filter          = "resource.type=\"cloud_scheduler_job\" AND metric.type=\"logging.googleapis.com/user/scheduler-execution-failed-${var.environment}\" AND metric.label.status=monitoring.regex.full_match(\"${local.transient_scheduler_statuses}\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.job_id", "metric.label.status"]
      }
    }
  }

  notification_channels = local.notification_channels

  documentation {
    content = <<-EOT
      A Cloud Scheduler job failed to invoke its target. The work it schedules is not running, and the scheduler still reports ENABLED.

      Read the status label first — it names the class:

      * PERMISSION_DENIED — the scheduler's service account has no roles/run.invoker on the Cloud Run Job it targets. Check the job's IAM policy: an empty policy (etag ACAB, no bindings) is the signature. Fix is a google_cloud_run_v2_job_iam_member in the module that declares the job, plus a depends_on from the scheduler.
      * NOT_FOUND — the HTTP target points at a route that does not exist. Note the platform-backend convention is /api/internal/*, not /internal/*.
      * INVALID_ARGUMENT — usually a malformed target URI or OIDC audience.

      Confirm with: gcloud scheduler jobs describe <job> --location=us-west1 --project=<project> --format="value(status,lastAttemptTime)"

      Then confirm the job is actually executing: gcloud run jobs executions list --job=<job> --region=us-west1 --project=<project>. Zero executions on a scheduler that has been enabled for weeks is the thing this alert exists to catch.
    EOT
  }

  depends_on = [time_sleep.log_metrics_propagate]
}

# ── 1b. A maintenance Cloud Task exhausted its attempts ─────────────────────
#
# platform-backend's maintenance no longer runs on Cloud Scheduler: it is armed
# as a Cloud Task on maintenance-tasks-<env> when the work appears, and the
# daily housekeeping job enqueues the rest (platform-backend
# src/jobs/housekeeping.ts). The routes that answer 409 on an alert-worthy
# condition (x402 balances and reconciliation, OU meter drift) relied on a
# failed scheduler run to page; a task that fails is the same fact one layer
# down. Shape of a failed attempt: severity ERROR on
# cloudtasks.googleapis.com/task_operations_log, jsonPayload.attemptResponseLog
# carrying the gRPC status, jsonPayload.task the task name, whose prefix
# (hk-<date>- / watch- / due-) and numeric suffix are stripped so the label is
# the KIND of work, not one task.
resource "google_logging_metric" "maintenance_task_attempt_failed" {
  project = google_project.platform_control.project_id
  name    = "maintenance-task-attempt-failed-${var.environment}"
  filter  = <<-EOT
    resource.type="cloud_tasks_queue"
    AND resource.labels.queue_id="maintenance-tasks-${var.environment}"
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
      description = "The maintenance work: a route path for a daily-pass task, else the armed kind"
    }
    labels {
      key         = "status"
      value_type  = "STRING"
      description = "gRPC status of the attempt, e.g. UNAUTHENTICATED or FAILED_PRECONDITION (409)"
    }
  }

  label_extractors = {
    "kind"   = "REGEXP_EXTRACT(jsonPayload.task, \"/tasks/(?:hk-[0-9]{8}-|watch-|due-)?(.+?)(?:-[0-9]+)?$\")"
    "status" = "EXTRACT(jsonPayload.attemptResponseLog.status)"
  }
}

resource "google_monitoring_alert_policy" "maintenance_task_failed" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Scheduled work: a maintenance task exhausted its attempts (${var.environment})"
  combiner     = "OR"

  # The queue makes three attempts with a minute of backoff. A failure the
  # retry then fixes is not news; three failures of the same kind in six hours
  # is a task the queue gave up on, and the work did not happen.
  conditions {
    display_name = "maintenance task failed three times (6 hours)"
    condition_threshold {
      filter          = "resource.type=\"cloud_tasks_queue\" AND metric.type=\"logging.googleapis.com/user/maintenance-task-attempt-failed-${var.environment}\""
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

  notification_channels = local.notification_channels

  documentation {
    content = <<-EOT
      A maintenance Cloud Task on maintenance-tasks-${var.environment} failed three times. The kind label names the work: a route path for an entry of the daily housekeeping pass, otherwise the armed kind (cost-ingest, x402-reload, digest, ...).

      * FAILED_PRECONDITION is an HTTP 409: the route answered that something is wrong (x402 treasury or wallet low, x402 or OU meter drift). Read the route's log line for what.
      * UNAUTHENTICATED / PERMISSION_DENIED: the task's identity or X-Service-Auth secret is not what the route checks (platform-backend src/infrastructure/maintenance-tasks.ts).
      * NOT_FOUND: the route does not exist in the deployed revision.

      Attempts: resource.type="cloud_tasks_queue" resource.labels.queue_id="maintenance-tasks-${var.environment}" severity=ERROR.
    EOT
  }

  depends_on = [time_sleep.log_metrics_propagate]
}

# ── 2. The job ran and failed ───────────────────────────────────────────────
#
# Complements the signal above rather than duplicating it: that one fires when
# the scheduler cannot start the job, this one when the job starts and exits
# non-zero. billing-partitions needed both — the invoker grant moved it from the
# first failure mode straight into the second, three times running.
resource "google_monitoring_alert_policy" "cloud_run_job_execution_failed" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Scheduled work: Cloud Run Job execution failed (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "a scheduled job execution failed in the last hour"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_job\" AND metric.type=\"run.googleapis.com/job/completed_execution_count\" AND metric.label.result=\"failed\" AND NOT resource.label.job_name=monitoring.regex.full_match(\"${local.ad_hoc_job_name_pattern}\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        # project_id is grouped, not just job_name. This project is the scoping
        # project of a metrics scope that spans the tenant projects, so this
        # policy sees their Cloud Run Jobs too. Grouping on job_name alone
        # dropped project_id from the output series, and the notification then
        # rendered the POLICY's project — sending you to
        # YOUR_CONTROL_PROJECT to debug a job that only exists in
        # YOUR_TENANT_PROJECT.
        group_by_fields = ["resource.label.job_name", "resource.label.project_id"]
      }
    }
  }

  notification_channels = local.notification_channels

  documentation {
    content = <<-EOT
      A Cloud Run Job execution finished in a failed state. These are maintenance, backup, retention and partition jobs — none of them has a user watching it, so this alert is the only feedback loop.

      Check project_id in the labels before anything else: this policy's metrics scope spans the tenant projects, so the failing job is frequently NOT in the project this alert was raised from.

      Read the execution's own logs, filtered to the execution id rather than the job name (a job-name filter mixes every past run together and hands you a stale, convincing, wrong answer):

        gcloud run jobs executions list --job=<job> --region=us-west1 --project=<project> --limit=1
        gcloud logging read 'resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="<execution>"' --project=<project> --limit=100 --format="value(textPayload)" --order=asc

      Common failure classes:
      * "Image not found" — the digest pinned in terraform/environments/<env>/terraform.tfvars was garbage-collected, or the module asks for a tag cloudbuild never writes. These *_image_sha values feed ONLY the jobs; the services ignore image changes, so the service stays healthy and hides it.
      * "Secret [...] not found" — the job did not set DB_APP_PASSWORD_SECRET and fell back to a code default that does not exist. The service sets it explicitly, so only the job hits this.
      * "connect ENOENT /cloudsql/..." — the job is missing the Cloud SQL volume mount, or vpc_access egress. The control-plane instance is private IP only and needs both.
    EOT
  }
}

# ── 3. A partitioned table rejected an insert ───────────────────────────────
#
# The last line of defence, and the one that matters most, because by the time
# it fires the data is already being dropped. A table that runs out of
# partitions loses every write while the writer catches and logs, so the
# request still succeeds, the service stays healthy and nothing alerts. This
# string is the only reliable signal for that.
resource "google_logging_metric" "partition_overflow" {
  project = google_project.platform_control.project_id
  name    = "partition-overflow-${var.environment}"
  filter  = <<-EOT
    (resource.type="cloud_run_revision" OR resource.type="cloud_run_job")
    AND "no partition of relation"
  EOT

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    labels {
      key         = "service"
      value_type  = "STRING"
      description = "Cloud Run service that could not write the row"
    }
  }

  label_extractors = {
    "service" = "EXTRACT(resource.labels.service_name)"
  }
}

resource "google_monitoring_alert_policy" "partition_overflow" {
  count = var.slack_bot_token != "" ? 1 : 0

  project      = google_project.platform_control.project_id
  display_name = "Partition overflow: a table ran out of partitions (${var.environment})"
  combiner     = "OR"

  # Two conditions rather than one, because a Monitoring filter must restrict
  # resource.type and the underlying log metric spans both: services write these
  # rows on the request path, jobs write them during maintenance. A single
  # filter cannot express the union, and omitting resource.type is rejected
  # outright ("must specify a restriction on resource.type").
  conditions {
    display_name = "service rejected a partitioned insert (15 min)"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/partition-overflow-${var.environment}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.service"]
      }
    }
  }

  conditions {
    display_name = "job rejected a partitioned insert (15 min)"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_job\" AND metric.type=\"logging.googleapis.com/user/partition-overflow-${var.environment}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.service"]
      }
    }
  }

  notification_channels = local.notification_channels

  documentation {
    content = <<-EOT
      A range-partitioned table rejected an insert because no partition covers the row's timestamp (SQLSTATE 23514). Rows are being lost right now.

      Every writer in this estate catches and logs this rather than failing the request, by design, so there is no other symptom: the API returns 200, the service reports healthy, and the data simply stops arriving. Treat any occurrence as an active incident.

      Immediate mitigation is one statement, and it needs no deploy, job, scheduler, IAM grant or extension:

        CREATE TABLE <table>_default PARTITION OF <table> DEFAULT;

      Then fix the maintenance that should have created the month. Note the ordering trap: once a DEFAULT partition holds rows for month M, CREATE TABLE ... PARTITION OF ... FOR VALUES for month M fails until those rows are moved out, so the DEFAULT partition is a safety net and never the mechanism.

      Background and the per-table runway: liftoff-developer-proxy/docs/partition-management.md.
    EOT
  }

  depends_on = [time_sleep.log_metrics_propagate]
}
