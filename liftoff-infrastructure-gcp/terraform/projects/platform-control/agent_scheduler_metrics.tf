locals {
  # Metrics written by both the reconciler (source='reconciler') and the
  # auditor (source='auditor'). The reconciler only writes missing/paused/failing;
  # the auditor only writes expected/enabled/paused/disabled/missing. Where the
  # sets overlap (missing, paused), both sources emit.
  source_labeled_metrics = [
    "missing_count",
    "paused_count",
    "failing_count",
    "enabled_count",
    "expected_count",
    "disabled_count",
  ]
}

resource "google_monitoring_metric_descriptor" "agent_scheduler_source_labeled" {
  for_each     = toset(local.source_labeled_metrics)
  project      = google_project.platform_control.project_id
  type         = "custom.googleapis.com/agent_scheduler/${each.value}"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  description  = "Agent scheduler ${each.value} per tenant per source (reconciler|auditor). Used by Layer A and Layer B alert policies."
  display_name = "Agent scheduler ${each.value}"

  labels {
    key         = "tenant_id"
    value_type  = "STRING"
    description = "Tenant UUID"
  }
  labels {
    key         = "source"
    value_type  = "STRING"
    description = "reconciler | auditor"
  }
}

# Auditor liveness, written unconditionally by audit-agent-schedulers.js on
# every run — including the runs that find nothing.
#
# The per-tenant metrics above cannot carry liveness: the auditor emits none of
# them when no tenant has a cron agent, which can be the steady state. An
# absence alert on those cannot distinguish "the auditor is dead" from "the
# auditor ran and had nothing to say", so without this there is no way to watch
# the auditor at all: it can fail on every run while every alert built on top
# of it reports healthy.
resource "google_monitoring_metric_descriptor" "agent_scheduler_auditor_liveness" {
  for_each = tomap({
    auditor_heartbeat         = "Always 1. Absence means the auditor is not running — this is what Layer C watches for source=auditor."
    auditor_audited_count     = "Tenants the auditor successfully compared this run."
    auditor_unreachable_count = "Tenants the auditor could not read schedulers for (cross-project IAM). >0 means the audit is silently partial."
  })

  project      = google_project.platform_control.project_id
  type         = "custom.googleapis.com/agent_scheduler/${each.key}"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  description  = each.value
  display_name = "Agent scheduler ${each.key}"
}

# Written by the Layer D emitter: how many tenants a given source failed to
# report for a given kind. Layer D's diff collapses a missing operand to 0,
# which reads identically to genuine agreement; this is the metric that says
# the comparison could not be made.
resource "google_monitoring_metric_descriptor" "agent_scheduler_source_absent" {
  project      = google_project.platform_control.project_id
  type         = "custom.googleapis.com/agent_scheduler/source_absent_count"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  description  = "Tenants for which this source emitted no sample in the read window. >0 means Layer D's diff for those tenants is not a real comparison."
  display_name = "Agent scheduler source_absent_count"

  labels {
    key         = "kind"
    value_type  = "STRING"
    description = "paused | missing | failing"
  }
  labels {
    key         = "source"
    value_type  = "STRING"
    description = "reconciler | auditor — the source that did NOT report"
  }
}

# A metric descriptor is not addressable by an alert policy the instant the
# Monitoring API accepts it. Creating both in one apply fails with
# "Cannot find metric(s) that match type = ...", which is what happened on the
# first apply of this change. Same trap, and the same remedy, as
# time_sleep.log_metrics_propagate in scheduled_work_alerts.tf — whose own
# comment calls this "precisely the kind of only-fails-once-so-nobody-fixes-it
# behaviour". depends_on alone orders the creates but does nothing about
# propagation.
resource "time_sleep" "agent_scheduler_metrics_propagate" {
  depends_on = [
    google_monitoring_metric_descriptor.agent_scheduler_auditor_liveness,
    google_monitoring_metric_descriptor.agent_scheduler_source_absent,
  ]
  create_duration = "120s"
}

resource "google_monitoring_metric_descriptor" "agent_scheduler_disagreement" {
  project      = google_project.platform_control.project_id
  type         = "custom.googleapis.com/agent_scheduler/disagreement_count"
  metric_kind  = "GAUGE"
  value_type   = "INT64"
  description  = "Absolute difference between reconciler and auditor values per (tenant, kind). >0 means Layer D detected disagreement."
  display_name = "Agent scheduler disagreement_count"

  labels {
    key         = "tenant_id"
    value_type  = "STRING"
    description = "Tenant UUID"
  }
  labels {
    key         = "kind"
    value_type  = "STRING"
    description = "paused | missing | failing — which underlying metric the diff is computed on"
  }
}
