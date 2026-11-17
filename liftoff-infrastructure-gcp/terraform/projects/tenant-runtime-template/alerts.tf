# Tenant-runtime Pub/Sub eventing alerts (C-1, C-2, C-3).
# Notification channels reuse local.alert_notification_channels declared in
# agent_creation_resilience.tf, which already gates on var.slack_bot_token.

# C-1: DLQ depth > 0 sustained 10 min on any control-plane DLQ subscription.
resource "google_monitoring_alert_policy" "pubsub_dlq_depth" {
  for_each              = toset(local.control_plane_subscription_topics)
  project               = google_project.tenant_runtime.project_id
  display_name          = "Pub/Sub DLQ has undelivered messages (${each.value}-${var.environment})"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels

  conditions {
    display_name = "DLQ depth > 0 for 10 min"
    condition_threshold {
      filter          = <<-EOT
        metric.type="pubsub.googleapis.com/subscription/num_undelivered_messages"
        AND resource.type="pubsub_subscription"
        AND resource.label.subscription_id="${each.value}-${var.environment}-dlq-sub"
      EOT
      duration        = "600s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
  alert_strategy { auto_close = "1800s" }
}

# C-2: coordinator-service push 5xx rate > 0.1/s for 5 min.
resource "google_monitoring_alert_policy" "coordinator_push_5xx" {
  count                 = var.split_services_deployed ? 1 : 0
  project               = google_project.tenant_runtime.project_id
  display_name          = "coordinator-service push 5xx rate elevated — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels

  conditions {
    display_name = "5xx rate > 0.1/s for 5 min"
    condition_threshold {
      filter          = <<-EOT
        metric.type="run.googleapis.com/request_count"
        AND resource.type="cloud_run_revision"
        AND resource.label.service_name="coordinator-service"
        AND metric.label.response_code_class="5xx"
      EOT
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.1
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  alert_strategy { auto_close = "1800s" }
}

# C-3: oldest unacked message on push sub > 300s.
resource "google_monitoring_alert_policy" "pubsub_push_unacked_age" {
  for_each              = toset(local.control_plane_subscription_topics)
  project               = google_project.tenant_runtime.project_id
  display_name          = "Pub/Sub push backlog (${each.value}-${var.environment})"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels

  conditions {
    display_name = "Oldest unacked > 300s"
    condition_threshold {
      filter          = <<-EOT
        metric.type="pubsub.googleapis.com/subscription/oldest_unacked_message_age"
        AND resource.type="pubsub_subscription"
        AND resource.label.subscription_id="${each.value}-${var.environment}-coordinator-push"
      EOT
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 300
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
  alert_strategy { auto_close = "1800s" }
}

# WS-1.6 — alert policies for the no-stubs-reliability log-based metrics.

resource "google_monitoring_alert_policy" "adapter_invoke_threw" {
  project               = google_project.tenant_runtime.project_id
  display_name          = "VendorSdkAdapter.invoke() threw (regression) — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels
  conditions {
    display_name = "adapter_invoke_threw > 0"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/adapter_invoke_threw\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "60s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  alert_strategy { auto_close = "1800s" }
  depends_on = [google_logging_metric.adapter_invoke_threw]
}

resource "google_monitoring_alert_policy" "stub_fallback_regression" {
  project               = google_project.tenant_runtime.project_id
  display_name          = "Stub-fallback fired (should be 0) — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels
  conditions {
    display_name = "stub_fallback_fired > 0"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/stub_fallback_fired\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "60s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  alert_strategy { auto_close = "1800s" }
  depends_on = [google_logging_metric.stub_fallback_fired]
}

resource "google_monitoring_alert_policy" "secret_load_failure" {
  project               = google_project.tenant_runtime.project_id
  display_name          = "Failed to load secret rate > 0 — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels
  conditions {
    display_name = "secret_load_failed > 0"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/secret_load_failed\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "60s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  alert_strategy { auto_close = "1800s" }
  depends_on = [google_logging_metric.secret_load_failed]
}

resource "google_monitoring_alert_policy" "canary_run_failed" {
  project               = google_project.tenant_runtime.project_id
  display_name          = "Synthetic canary failed — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels
  conditions {
    display_name = "canary_run_outcome=error rate > 0 (sustained 10 min)"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/canary_run_outcome\" resource.type=\"cloud_run_revision\" metric.label.outcome=\"error\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  alert_strategy { auto_close = "1800s" }
  depends_on = [google_logging_metric.canary_run_outcome]
}

# NOTE: agent_health_regressed alert moved to platform-ci (the platform-control
# project the diagnostics job logs to) alongside its metric.

resource "google_monitoring_alert_policy" "tenant_id_unknown" {
  project               = google_project.tenant_runtime.project_id
  display_name          = "Logs missing tenant attribution — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels
  conditions {
    display_name = "tenant_id='unknown' log count > 10/min"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/tenant_id_unknown\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  alert_strategy { auto_close = "1800s" }
  depends_on = [google_logging_metric.tenant_id_unknown]
}

# Vendor MCP enumeration failing → tools silently dropped for affected runs.
# Unlike adapter_invoke_threw (page on any occurrence), enumeration degrades
# gracefully, so a single transient vendor blip is expected and must NOT page.
# We alert on a sustained RATE — a systemic vendor outage or OAuth/Bearer token
# expiry failing enumeration across many invocations. Triage via the server_id /
# reason labels on the metric.
# THRESHOLD IS A STARTING VALUE — calibrate against observed
# vendor_mcp_enumerate_failed volume once data flows; per-tenant enumeration
# frequency (one tools/list per bound vendor server per invocation) is not yet
# measured, so 0.05/s over 10m is a conservative first cut, not a tuned number.
resource "google_monitoring_alert_policy" "vendor_mcp_enumerate_failures" {
  project               = google_project.tenant_runtime.project_id
  display_name          = "Vendor MCP enumeration failing — tools silently dropped — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels
  conditions {
    display_name = "vendor_mcp_enumerate_failed rate > 0.05/s for 10m"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/vendor_mcp_enumerate_failed\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.05
      duration        = "600s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  documentation {
    content = "Vendor-hosted MCP `tools/list` enumeration is degrading to [] — affected agents silently lose that server's tools for the run (recovery + HITL still apply to the tools that DID enumerate). Common causes: vendor MCP outage, OAuth/Bearer token expiry (reason=auth), or a bad MCP URL. Triage by the server_id / reason labels. See docs/runbooks/ADAPTER_INVOCATION_TROUBLESHOOTING.md."
  }
  alert_strategy { auto_close = "1800s" }
  depends_on = [google_logging_metric.vendor_mcp_enumerate_failed]
}

# A newly created log-based metric is not immediately addressable by an alert
# policy: Cloud Monitoring answers `Cannot find metric(s) that match type ...`
# for up to ten minutes, which is exactly how the first dev apply of these two
# policies failed. depends_on alone does not help, because the metric resource
# is already "created" as far as Terraform is concerned.
#
# Same shape as time_sleep.wait_pause_resume_failure_metric: the sleep is
# replaced whenever either metric is, and the policies are replaced with it, so
# a metric that gets recreated later takes its policies down and brings them
# back after the wait rather than 404ing again.
resource "time_sleep" "wait_dlq_metrics" {
  depends_on = [
    google_logging_metric.dlq_backlog_pending,
    google_logging_metric.dlq_replay_capped,
  ]
  create_duration = "120s"

  lifecycle {
    replace_triggered_by = [
      google_logging_metric.dlq_backlog_pending,
      google_logging_metric.dlq_replay_capped,
    ]
  }
}

# Application DLQ backlog. Companion to the Pub/Sub-layer DLQ alerts above,
# which watch the broker and say nothing about the two tables the application
# writes when it gives up on an event.
#
# Threshold is 0, on purpose. A dead-letter queue is a work queue: a non-empty
# one means somebody owes it an action, and the moment a standing backlog is
# normal the queue stops being read.
#
# Duration is 24h rather than minutes because the metric is emitted by a daily
# sweep, not continuously. One reading is enough to fire.
resource "google_monitoring_alert_policy" "dlq_backlog_pending" {
  project               = google_project.tenant_runtime.project_id
  display_name          = "Application DLQ has unresolved rows — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels

  conditions {
    display_name = "A sweep reported unresolved dead-lettered rows"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/dlq_backlog_pending\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "86400s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["metric.label.surface"]
      }
    }
  }

  documentation {
    content = <<-EOT
      One of the application dead-letter tables has rows nobody has resolved.
      Retention deliberately never deletes these, so the count only goes down
      when a person acts on them.

      How many, and how old, are in the log entry that raised this: filter on
      jsonPayload.event="dlq_backlog_pending" and read pendingCount and
      oldestAgeHours. Age matters more than count — one row stuck for four
      months is worse than fifty from this morning.

      surface=dlq_messages — the app gave up on a control-plane event (poison
      cap at delivery 8, schema-invalid, or retries exhausted). Check
      failure_class: 'transient' means replay once the dependency is healthy;
      'permanent' means the producer or the schema has to change first, and
      replaying it will not help.

      surface=failed_events — the drainer pulled the message off the Pub/Sub
      DLQ and did not republish it. republish_error says why: either the
      payload would not parse, or the event hit the replay cap (see the
      dlq_replay_capped alert).

      Resolve by replaying, or by discarding with a reason. Do not widen the
      retention sweep to cover these; that is how the work gets lost while the
      table looks healthy.
    EOT
  }

  alert_strategy { auto_close = "604800s" }
  depends_on = [time_sleep.wait_dlq_metrics]

  lifecycle {
    replace_triggered_by = [google_logging_metric.dlq_backlog_pending]
  }
}

# The drainer giving up on an event. This is the end of the automatic recovery
# path, so it is never routine.
resource "google_monitoring_alert_policy" "dlq_replay_capped" {
  project               = google_project.tenant_runtime.project_id
  display_name          = "DLQ replay cap reached — event will not be republished — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels

  conditions {
    display_name = "Any replay-capped event"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/dlq_replay_capped\" AND resource.type=\"cloud_run_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  documentation {
    content = <<-EOT
      An event came back from the live topic more times than the drainer's
      replay budget allows, so it has stopped being republished and is held in
      failed_events with republish_error set.

      This means republishing is not the fix. Read the payload out of
      failed_events and find out why the handler keeps rejecting it. Once the
      cause is fixed, replay it deliberately (scripts/replay-pubsub-dlq.ts,
      audited in dlq_replay_audit) rather than raising the cap.

      Before this cap existed, the same condition looped silently: prod
      republished 389 events 8,086 times over nine days in June 2026.
    EOT
  }

  alert_strategy { auto_close = "604800s" }
  depends_on = [time_sleep.wait_dlq_metrics]

  lifecycle {
    replace_triggered_by = [google_logging_metric.dlq_replay_capped]
  }
}

# ── canonical rebuild canary ────────────────────────────────────────────────
#
# A job that runs perfectly while reporting a broken record is "healthy" in the
# way the scheduler-failure alert means, and not in the way that matters. That
# alert watches whether the job RAN; this one watches what it FOUND.
#
# The finding it exists for: a canonical record with no user turn. The recorder
# taps adapter output and, for the first days after the column shipped, nothing
# recorded the input — so a rebuilt conversation handed the next engine the
# agent's own answers with none of the questions. Every count-based check passed
# throughout, which is why this is watched as content rather than as a count.
resource "google_logging_metric" "canonical_rebuild_canary_finding" {
  project     = google_project.tenant_runtime.project_id
  name        = "canonical_rebuild_canary_finding"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    AND jsonPayload.event="canonical_rebuild_canary_finding"
  EOT
  description = "One per recorded conversation the canary could not rebuild for another engine. A finding here means the stored record is unusable, not that the job failed."
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "source_engine"
      value_type  = "STRING"
      description = "Engine that wrote the record"
    }
    labels {
      key         = "target_engine"
      value_type  = "STRING"
      description = "Engine the rebuild was attempted for; absent for a writer fault"
    }
  }
  label_extractors = {
    "source_engine" = "EXTRACT(jsonPayload.sourceEngine)"
    "target_engine" = "EXTRACT(jsonPayload.targetEngine)"
  }
}

# See the comment on time_sleep.wait_dlq_metrics: a newly created log-based
# metric is not addressable by an alert policy for up to ten minutes, and
# depends_on does not help because Terraform already considers the metric
# created. This is the same shape, and it is here rather than learned again
# because the first dev apply of the scheduler-failure alert failed exactly this
# way — the alert built to catch invisible breakage, broken invisibly on its own
# first apply.
resource "time_sleep" "wait_canonical_rebuild_canary_metric" {
  depends_on = [google_logging_metric.canonical_rebuild_canary_finding]

  create_duration = "120s"

  lifecycle {
    replace_triggered_by = [google_logging_metric.canonical_rebuild_canary_finding]
  }
}

resource "google_monitoring_alert_policy" "canonical_rebuild_canary_finding" {
  project               = google_project.tenant_runtime.project_id
  display_name          = "A recorded conversation cannot be rebuilt — ${var.environment}"
  combiner              = "OR"
  notification_channels = local.alert_notification_channels

  conditions {
    display_name = "canonical_rebuild_canary_finding > 0"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/canonical_rebuild_canary_finding\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      # ANY occurrence, over one alignment window. Unlike a vendor blip, this is
      # not a rate to be tolerated: one unrebuildable record means the engine
      # switch that record exists to survive would discard the conversation, and
      # a writer fault means every record written since is suspect.
      duration = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.source_engine", "metric.label.target_engine"]
      }
    }
  }

  documentation {
    content = <<-EOT
      The canonical-rebuild canary read a real recorded conversation and could
      not rebuild it for another engine. `decideArtifactResume`'s `fallback`
      verdict depends on that rebuild, so this is the conversation that would be
      DISCARDED on a provider switch.

      Three shapes, and they are different problems:

      * NO RECORD AT ALL — the canary sampled zero rows. Nothing is broken about
        what was written, because nothing was written. Expect this on a tenant
        that has had no chat turn or autonomous run since the canonical writer
        deployed, and confirm with:
          SELECT count(*) FILTER (WHERE canonical_content IS NOT NULL)
            FROM chat_sessions;
        against the tenant database. It is reported rather than passed over
        because a canary that checked nothing has established nothing, and a
        green light standing in for an absent one is the failure mode this whole
        job exists to catch.

      * NO user turn in the record — a fault in the WRITER. The recorder taps
        adapter OUTPUT; if the input is not recorded, the stored conversation is
        the agent talking to itself. One occurrence means every record written
        since is suspect, not just this one. Check the recorder's input tap
        first, not the mappers.

      * The rebuild failed or the target engine could not read it — a fault in a
        mapper or an adapter. `target_engine` names which. Certification covers
        this against fixtures, so a finding here that certification does not
        reproduce means the real record has a shape no fixture has.

      Findings are logged at ERROR as `canonical_rebuild_canary_finding` with the
      problem text. The aggregate line is `canonical_rebuild_canary`.
    EOT
  }

  alert_strategy { auto_close = "86400s" }
  depends_on = [time_sleep.wait_canonical_rebuild_canary_metric]
}
