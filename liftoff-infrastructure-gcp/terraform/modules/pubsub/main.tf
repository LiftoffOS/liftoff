# Pub/Sub Module
# Per Section 4: Async control-plane and workflow events with subscriptions and DLQ

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "tenant_id" {
  description = "Tenant ID for tenant-specific topics"
  type        = string
  default     = ""
}

variable "cloud_run_service_url" {
  description = "Cloud Run service URL for push subscriptions"
  type        = string
  default     = ""
}

variable "notification_channels" {
  description = "Cloud Monitoring notification channel IDs for alert policies"
  type        = list(string)
  default     = []
}

variable "service_account_email" {
  description = "Service account email for Pub/Sub"
  type        = string
  default     = ""
}

# Per Section 4: Control plane events
locals {
  control_plane_topics = var.tenant_id == "" ? [
    "tenant-entitlement-updated",
    "tenant-suspended",
    "tenant-reactivated",
    "tenant-deployment-approved",
    "tenant-model-config-updated",
    "tenant-prompt-bundle-updated",
    "tenant-feature-flag-updated",
    "tenant-migration-started",
    "tenant-migration-completed",
    # Per Correction Protocol: Control plane publishes correction events
    "correction-requested",
    "correction-bulk-requested",
  ] : []

  # Tenant runtime workflow events
  tenant_topics = var.tenant_id != "" ? [
    "workflow-events",
    "task-events",
    "action-events",
    "connector-events",
    "escalation-events",
    "reflection-events",
  ] : []

  # Topics that need dead letter queues
  dlq_enabled_topics = var.tenant_id == "" ? [
    "tenant-entitlement-updated",
    "tenant-suspended",
    "tenant-reactivated",
    # Per Correction Protocol: DLQ for failed corrections
    "correction-requested",
    "correction-bulk-requested",
    ] : [
    "workflow-events",
    "task-events",
    "action-events",
  ]
}

# ==========================================
# Dead Letter Queue Topics
# ==========================================

resource "google_pubsub_topic" "dlq" {
  for_each = toset(local.dlq_enabled_topics)

  project = var.project_id
  name    = "${each.value}-${var.environment}-dlq"

  message_retention_duration = "1209600s" # 14 days for DLQ

  labels = {
    environment = var.environment
    type        = "dlq"
    source      = each.value
  }
}

# DLQ subscriptions for manual processing
resource "google_pubsub_subscription" "dlq" {
  for_each = toset(local.dlq_enabled_topics)

  project = var.project_id
  name    = "${each.value}-${var.environment}-dlq-sub"
  topic   = google_pubsub_topic.dlq[each.key].id

  # Keep DLQ messages for 14 days
  message_retention_duration = "1209600s"
  retain_acked_messages      = true
  ack_deadline_seconds       = 60

  # No expiration for DLQ subscriptions
  expiration_policy {
    ttl = ""
  }

  labels = {
    environment = var.environment
    type        = "dlq"
  }
}

# ==========================================
# Control Plane Topics and Subscriptions
# ==========================================

resource "google_pubsub_topic" "control_plane" {
  for_each = toset(local.control_plane_topics)

  project = var.project_id
  name    = "${each.value}-${var.environment}"

  message_retention_duration = "604800s" # 7 days

  labels = {
    environment = var.environment
    type        = "control-plane"
  }
}

# Control plane subscriptions for tenant runtime
resource "google_pubsub_subscription" "control_plane" {
  for_each = toset(local.control_plane_topics)

  project = var.project_id
  name    = "${each.value}-${var.environment}-sub"
  topic   = google_pubsub_topic.control_plane[each.key].id

  # Ack deadline of 60 seconds
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s" # 7 days

  # Enable exactly-once delivery for critical events
  # Per Correction Protocol: Enable exactly-once for correction events
  enable_exactly_once_delivery = contains([
    "tenant-entitlement-updated",
    "tenant-suspended",
    "tenant-reactivated",
    "correction-requested",
    "correction-bulk-requested",
  ], each.key)

  # Retry policy
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s" # 10 minutes max
  }

  # Dead letter policy for critical topics
  dynamic "dead_letter_policy" {
    for_each = contains(local.dlq_enabled_topics, each.key) ? [1] : []
    content {
      dead_letter_topic     = google_pubsub_topic.dlq[each.key].id
      max_delivery_attempts = 5
    }
  }

  # No expiration
  expiration_policy {
    ttl = ""
  }

  labels = {
    environment = var.environment
    type        = "control-plane"
  }
}

# ==========================================
# Tenant Runtime Topics and Subscriptions
# ==========================================

resource "google_pubsub_topic" "tenant" {
  for_each = toset(local.tenant_topics)

  project = var.project_id
  name    = "${each.value}-${var.environment}"

  message_retention_duration = "604800s" # 7 days

  labels = {
    environment = var.environment
    type        = "tenant-runtime"
    tenant_id   = var.tenant_id
  }
}

# Tenant runtime subscriptions
resource "google_pubsub_subscription" "tenant" {
  for_each = toset(local.tenant_topics)

  project = var.project_id
  name    = "${each.value}-${var.environment}-sub"
  topic   = google_pubsub_topic.tenant[each.key].id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  # Retry policy
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  # Dead letter policy
  dynamic "dead_letter_policy" {
    for_each = contains(local.dlq_enabled_topics, each.key) ? [1] : []
    content {
      dead_letter_topic     = google_pubsub_topic.dlq[each.key].id
      max_delivery_attempts = 5
    }
  }

  expiration_policy {
    ttl = ""
  }

  labels = {
    environment = var.environment
    type        = "tenant-runtime"
    tenant_id   = var.tenant_id
  }
}

# Reactive subscriptions router subscriptions.
#
# The subscription-router in tenant-runtime listens on dedicated -rs
# subscriptions so its consumption is independent from the existing
# agent-trigger consumer (which reads connector-events-${env}-sub).
# This gives the router its own ack-deadline + retry policy without
# affecting the existing event-trigger code path.
resource "google_pubsub_subscription" "reactive_subscriptions_router" {
  for_each = var.tenant_id != "" ? toset(["connector-events", "system-events"]) : toset([])

  project = var.project_id
  name    = "${each.value}-${var.environment}-rs"
  topic   = each.value == "connector-events" ? google_pubsub_topic.tenant["connector-events"].id : google_pubsub_topic.system_events[0].id

  # Predicate evaluation + window upsert + entity-state diff can take a few
  # seconds when many subscriptions match. 60s is comfortably above p99.
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  # Reuse the existing connector-events DLQ when applicable; system-events
  # has no DLQ (router-side errors don't warrant retries beyond Pub/Sub's).
  dynamic "dead_letter_policy" {
    for_each = each.value == "connector-events" && contains(local.dlq_enabled_topics, "connector-events") ? [1] : []
    content {
      dead_letter_topic     = google_pubsub_topic.dlq["connector-events"].id
      max_delivery_attempts = 5
    }
  }

  expiration_policy {
    ttl = ""
  }

  labels = {
    environment = var.environment
    type        = "reactive-subscriptions-router"
    tenant_id   = var.tenant_id
  }
}

# system-events topic for runtime-emitted events (workflow.completed,
# action.compensated, agent.escalation.resolved, …). Subscribed to by the
# reactive subscriptions router so agents can react declaratively.
resource "google_pubsub_topic" "system_events" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  name    = "system-events-${var.environment}"

  message_retention_duration = "604800s"

  labels = {
    environment = var.environment
    type        = "tenant-runtime"
    tenant_id   = var.tenant_id
  }
}

# Push subscription for workflow events (if Cloud Run URL provided)
resource "google_pubsub_subscription" "workflow_push" {
  count = var.tenant_id != "" && var.cloud_run_service_url != "" ? 1 : 0

  project = var.project_id
  name    = "workflow-events-${var.environment}-push"
  topic   = google_pubsub_topic.tenant["workflow-events"].id

  ack_deadline_seconds = 60

  push_config {
    push_endpoint = "${var.cloud_run_service_url}/api/events/workflow"

    attributes = {
      x-goog-version = "v1"
    }

    dynamic "oidc_token" {
      for_each = var.service_account_email != "" ? [1] : []
      content {
        service_account_email = var.service_account_email
      }
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq["workflow-events"].id
    max_delivery_attempts = 5
  }

  labels = {
    environment = var.environment
    type        = "push"
  }
}

# ==========================================
# Message Filtering Subscriptions
# ==========================================

# Filtered subscription for high-priority workflow events
resource "google_pubsub_subscription" "workflow_high_priority" {
  count = var.tenant_id != "" ? 1 : 0

  project = var.project_id
  name    = "workflow-events-${var.environment}-high-priority"
  topic   = google_pubsub_topic.tenant["workflow-events"].id

  ack_deadline_seconds = 30 # Shorter deadline for high priority

  # Filter for high priority events
  filter = "attributes.priority = \"high\""

  retry_policy {
    minimum_backoff = "5s"
    maximum_backoff = "60s" # Faster retries for high priority
  }

  expiration_policy {
    ttl = ""
  }

  labels = {
    environment = var.environment
    type        = "filtered"
    priority    = "high"
  }
}

# ==========================================
# IAM Bindings
# ==========================================

# Allow service account to publish to control plane topics
resource "google_pubsub_topic_iam_member" "control_plane_publisher" {
  for_each = var.service_account_email != "" ? toset(local.control_plane_topics) : toset([])

  project = var.project_id
  topic   = google_pubsub_topic.control_plane[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${var.service_account_email}"
}

# Allow service account to subscribe to control plane topics
resource "google_pubsub_subscription_iam_member" "control_plane_subscriber" {
  for_each = var.service_account_email != "" ? toset(local.control_plane_topics) : toset([])

  project      = var.project_id
  subscription = google_pubsub_subscription.control_plane[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${var.service_account_email}"
}

# Allow service account to publish to tenant topics
resource "google_pubsub_topic_iam_member" "tenant_publisher" {
  for_each = var.service_account_email != "" && var.tenant_id != "" ? toset(local.tenant_topics) : toset([])

  project = var.project_id
  topic   = google_pubsub_topic.tenant[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${var.service_account_email}"
}

# Allow service account to publish to DLQ (for reprocessing)
resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  for_each = var.service_account_email != "" ? toset(local.dlq_enabled_topics) : toset([])

  project = var.project_id
  topic   = google_pubsub_topic.dlq[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${var.service_account_email}"
}

# ==========================================
# Outputs
# ==========================================

output "control_plane_topics" {
  description = "Control plane topic IDs"
  value       = { for k, v in google_pubsub_topic.control_plane : k => v.id }
}

output "control_plane_subscriptions" {
  description = "Control plane subscription IDs"
  value       = { for k, v in google_pubsub_subscription.control_plane : k => v.id }
}

output "tenant_topics" {
  description = "Tenant runtime topic IDs"
  value       = { for k, v in google_pubsub_topic.tenant : k => v.id }
}

output "tenant_subscriptions" {
  description = "Tenant runtime subscription IDs"
  value       = { for k, v in google_pubsub_subscription.tenant : k => v.id }
}

# Reactive subscriptions router
output "reactive_subscriptions_router_subs" {
  description = "Reactive subscriptions router subscription IDs (connector-events-rs, system-events-rs)"
  value       = { for k, v in google_pubsub_subscription.reactive_subscriptions_router : k => v.id }
}

output "system_events_topic" {
  description = "System-events topic ID for runtime-emitted events consumed by reactive subscriptions"
  value       = length(google_pubsub_topic.system_events) > 0 ? google_pubsub_topic.system_events[0].id : ""
}

output "dlq_topics" {
  description = "Dead letter queue topic IDs"
  value       = { for k, v in google_pubsub_topic.dlq : k => v.id }
}

output "dlq_subscriptions" {
  description = "Dead letter queue subscription IDs"
  value       = { for k, v in google_pubsub_subscription.dlq : k => v.id }
}

# ==========================================
# Correction DLQ Monitoring Alerts
# Per Correction Protocol: Alert on failed corrections
# ==========================================

# Alert when messages land in correction DLQ
resource "google_monitoring_alert_policy" "correction_dlq" {
  count = var.tenant_id == "" ? 1 : 0

  project      = var.project_id
  display_name = "Correction DLQ Messages (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "Correction DLQ Message Count > 0"

    condition_threshold {
      filter = <<-EOT
        resource.type = "pubsub_subscription"
        AND resource.labels.subscription_id = one_of("correction-requested-${var.environment}-dlq-sub", "correction-bulk-requested-${var.environment}-dlq-sub")
        AND metric.type = "pubsub.googleapis.com/subscription/num_undelivered_messages"
      EOT

      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.subscription_id"]
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = <<-EOT
      ## Correction Protocol DLQ Alert

      One or more correction requests have failed delivery and landed in the dead-letter queue.

      **Action Required:**
      1. Check Cloud Console > Pub/Sub > Subscriptions > `correction-*-${var.environment}-dlq-sub`
      2. Review message attributes for tenant_id, correction_request_id, and error details
      3. Check Tenant Runtime logs for correction execution errors
      4. Messages can be replayed after fixing the underlying issue

      **Common Causes:**
      - Tenant Runtime unavailable
      - External API rate limits exceeded
      - Resource no longer exists
      - Authentication/authorization errors
    EOT
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "604800s" # 7 days
  }
}

# Alert for high correction DLQ backlog
resource "google_monitoring_alert_policy" "correction_dlq_backlog" {
  count = var.tenant_id == "" ? 1 : 0

  project      = var.project_id
  display_name = "High Correction DLQ Backlog (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "Correction DLQ backlog > 100 messages"

    condition_threshold {
      filter = <<-EOT
        resource.type = "pubsub_subscription"
        AND resource.labels.subscription_id = one_of("correction-requested-${var.environment}-dlq-sub", "correction-bulk-requested-${var.environment}-dlq-sub")
        AND metric.type = "pubsub.googleapis.com/subscription/num_undelivered_messages"
      EOT

      duration        = "300s" # 5 minutes
      comparison      = "COMPARISON_GT"
      threshold_value = 100

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.subscription_id"]
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = <<-EOT
      ## High Correction DLQ Backlog Alert

      More than 100 correction requests are stuck in the dead-letter queue.

      **This indicates a systemic issue** - investigate immediately.

      **Action Required:**
      1. Check Tenant Runtime health and logs
      2. Verify external API connectivity
      3. Check for tenant-wide issues
      4. Consider pausing new correction requests until resolved
    EOT
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "604800s" # 7 days
  }
}
