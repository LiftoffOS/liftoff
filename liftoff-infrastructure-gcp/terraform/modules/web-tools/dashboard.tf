resource "google_logging_metric" "web_fetch_router_latency" {
  name    = "web_fetch_router_latency_ms"
  filter  = "resource.type=\"cloud_run_revision\" AND jsonPayload.message=\"web_fetch_router success\""
  project = var.tenant_runtime_project
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }
  value_extractor  = "EXTRACT(jsonPayload.elapsed_ms)"
  label_extractors = { vendor = "EXTRACT(jsonPayload.vendor)" }
  bucket_options {
    explicit_buckets { bounds = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000] }
  }
}

resource "google_logging_metric" "web_fetch_router_success_count" {
  name    = "web_fetch_router_success_count"
  filter  = "resource.type=\"cloud_run_revision\" AND jsonPayload.message=\"web_fetch_router success\""
  project = var.tenant_runtime_project
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  label_extractors = { vendor = "EXTRACT(jsonPayload.vendor)" }
}

resource "google_logging_metric" "web_fetch_router_failure_count" {
  name    = "web_fetch_router_failure_count"
  filter  = "resource.type=\"cloud_run_revision\" AND jsonPayload.message=\"web_fetch_router vendor failed\""
  project = var.tenant_runtime_project
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  label_extractors = { vendor = "EXTRACT(jsonPayload.vendor)" }
}

resource "google_logging_metric" "web_tool_invocations" {
  name    = "web_tool_invocations"
  filter  = "resource.type=\"cloud_run_revision\" AND jsonPayload.message=~\"^web_(fetch_advanced|extract|task|research|diff|identity_connect|session_save)_invoked$\""
  project = var.tenant_runtime_project
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  label_extractors = { tool = "REGEXP_EXTRACT(jsonPayload.message, \"^(web_[a-z_]+)_invoked$\")" }
}

resource "google_monitoring_dashboard" "web_tools" {
  project = var.tenant_runtime_project
  dashboard_json = jsonencode({
    displayName = "Web Tools — Vendor Health"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          width = 6, height = 4, xPos = 0, yPos = 0
          widget = {
            title = "Router success rate per vendor (1h)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { timeSeriesFilter = {
                  filter      = "metric.type=\"logging.googleapis.com/user/web_fetch_router_success_count\""
                  aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_RATE", groupByFields = ["metric.label.vendor"] }
                } }
              }]
            }
          }
        },
        {
          width = 6, height = 4, xPos = 6, yPos = 0
          widget = {
            title = "Router failure count per vendor (1h)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { timeSeriesFilter = {
                  filter      = "metric.type=\"logging.googleapis.com/user/web_fetch_router_failure_count\""
                  aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_RATE", groupByFields = ["metric.label.vendor"] }
                } }
              }]
            }
          }
        },
        {
          width = 6, height = 4, xPos = 0, yPos = 4
          widget = {
            title = "Per-tool call rate"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = { timeSeriesFilter = {
                  filter      = "metric.type=\"logging.googleapis.com/user/web_tool_invocations\""
                  aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_RATE", groupByFields = ["metric.label.tool"] }
                } }
              }]
            }
          }
        },
        {
          width = 6, height = 4, xPos = 6, yPos = 4
          widget = {
            title = "Router latency p50/p99 per vendor (ms)"
            xyChart = {
              dataSets = [
                {
                  timeSeriesQuery = { timeSeriesFilter = {
                    filter      = "metric.type=\"logging.googleapis.com/user/web_fetch_router_latency_ms\""
                    aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_PERCENTILE_50", groupByFields = ["metric.label.vendor"] }
                  } }
                },
                {
                  timeSeriesQuery = { timeSeriesFilter = {
                    filter      = "metric.type=\"logging.googleapis.com/user/web_fetch_router_latency_ms\""
                    aggregation = { alignmentPeriod = "60s", perSeriesAligner = "ALIGN_PERCENTILE_99", groupByFields = ["metric.label.vendor"] }
                  } }
                },
              ]
            }
          }
        },
      ]
    }
  })
}
