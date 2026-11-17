resource "google_monitoring_alert_policy" "web_fetch_anomaly" {
  display_name = "Agent web_fetch anomaly — high volume"
  combiner     = "OR"
  conditions {
    display_name = "web_fetch_invoked > 20/hour per agent"
    condition_threshold {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.message="web_fetch_invoked"
      EOT
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
        group_by_fields    = ["jsonPayload.agent_id"]
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 20
      duration        = "0s"
    }
  }
  notification_channels = [var.alert_notification_channel]
  project               = var.tenant_runtime_project
}

resource "google_monitoring_alert_policy" "web_fetch_advanced_anomaly" {
  display_name = "Agent web_fetch_advanced anomaly — high volume"
  combiner     = "OR"
  conditions {
    display_name = "web_fetch_advanced_invoked > 50/hour per agent"
    condition_threshold {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.message="web_fetch_advanced_invoked"
      EOT
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
        group_by_fields    = ["jsonPayload.agent_id"]
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 50
      duration        = "0s"
    }
  }
  notification_channels = [var.alert_notification_channel]
  project               = var.tenant_runtime_project
}

resource "google_monitoring_alert_policy" "web_extract_anomaly" {
  display_name = "Agent web_extract anomaly — high volume"
  combiner     = "OR"
  conditions {
    display_name = "web_extract_invoked > 20/hour per agent"
    condition_threshold {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.message="web_extract_invoked"
      EOT
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
        group_by_fields    = ["jsonPayload.agent_id"]
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 20
      duration        = "0s"
    }
  }
  notification_channels = [var.alert_notification_channel]
  project               = var.tenant_runtime_project
}

resource "google_monitoring_alert_policy" "web_task_anomaly" {
  display_name = "Agent web_task anomaly — high volume"
  combiner     = "OR"
  conditions {
    display_name = "web_task_invoked > 5/hour per agent"
    condition_threshold {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.message="web_task_invoked"
      EOT
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
        group_by_fields    = ["jsonPayload.agent_id"]
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"
    }
  }
  notification_channels = [var.alert_notification_channel]
  project               = var.tenant_runtime_project
}

resource "google_monitoring_alert_policy" "web_session_save_anomaly" {
  display_name = "Agent web_session_save anomaly — high volume"
  combiner     = "OR"
  conditions {
    display_name = "web_session_save_invoked > 3/hour per agent"
    condition_threshold {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.message="web_session_save_invoked"
      EOT
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
        group_by_fields    = ["jsonPayload.agent_id"]
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 3
      duration        = "0s"
    }
  }
  notification_channels = [var.alert_notification_channel]
  project               = var.tenant_runtime_project
}

resource "google_monitoring_alert_policy" "web_research_anomaly" {
  display_name = "Agent web_research anomaly — high volume"
  combiner     = "OR"
  conditions {
    display_name = "web_research_invoked > 3/hour per agent"
    condition_threshold {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.message="web_research_invoked"
      EOT
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
        group_by_fields    = ["jsonPayload.agent_id"]
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 3
      duration        = "0s"
    }
  }
  notification_channels = [var.alert_notification_channel]
  project               = var.tenant_runtime_project
}

resource "google_monitoring_alert_policy" "web_diff_anomaly" {
  display_name = "Agent web_diff anomaly — high volume"
  combiner     = "OR"
  conditions {
    display_name = "web_diff_invoked > 10/hour per agent"
    condition_threshold {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.message="web_diff_invoked"
      EOT
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
        group_by_fields    = ["jsonPayload.agent_id"]
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "0s"
    }
  }
  notification_channels = [var.alert_notification_channel]
  project               = var.tenant_runtime_project
}

resource "google_monitoring_alert_policy" "web_identity_connect_anomaly" {
  display_name = "Agent web_identity_connect anomaly — high volume"
  combiner     = "OR"
  conditions {
    display_name = "web_identity_connect_invoked > 5/hour per agent"
    condition_threshold {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND jsonPayload.message="web_identity_connect_invoked"
      EOT
      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_COUNT"
        group_by_fields    = ["jsonPayload.agent_id"]
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"
    }
  }
  notification_channels = [var.alert_notification_channel]
  project               = var.tenant_runtime_project
}

resource "google_monitoring_alert_policy" "vendor_quota_high" {
  display_name = "Web tools — vendor quota/spend high"
  combiner     = "OR"
  conditions {
    display_name = "vendor quota or spend >= 80%"
    condition_threshold {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND (jsonPayload.event="anchor_quota_high" OR jsonPayload.event="firecrawl_quota_high" OR jsonPayload.event="tavily_quota_high" OR jsonPayload.event="vendor_spend_high")
      EOT
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
    }
  }
  notification_channels = [var.alert_notification_channel]
  project               = var.tenant_runtime_project
}
