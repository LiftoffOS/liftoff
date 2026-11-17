# pubsub-events: per-service Pub/Sub topics (plan 0w).
# Topics are owned by the PRODUCING service. Consumers own their own
# subscriptions in their own service's module (billing-events-platform-
# backend-sub lives in platform-backend's terraform, etc.). This module
# only creates topics + DLQ topics.

locals {
  labels = {
    env        = var.environment
    managed_by = "terraform"
  }
  topic_env_map = { for k, v in var.topics : k => "${k}-${var.environment}" }
}

resource "google_pubsub_topic" "events" {
  for_each = var.topics

  project = var.project_id
  name    = local.topic_env_map[each.key]

  message_retention_duration = each.value.retention

  labels = merge(local.labels, { service = each.key })

  dynamic "message_storage_policy" {
    for_each = var.kms_key_id == "" ? [] : [1]
    content {
      allowed_persistence_regions = ["us-west1"]
    }
  }

  # CMEK if provided.
  kms_key_name = var.kms_key_id == "" ? null : var.kms_key_id
}

# Dead-letter topic per primary topic. Subscribers configure dead_letter_policy
# to point here when they can't ack.
resource "google_pubsub_topic" "dlq" {
  for_each = var.topics

  project = var.project_id
  name    = "${local.topic_env_map[each.key]}-dlq"

  message_retention_duration = each.value.dlq_retention
  labels                     = merge(local.labels, { service = each.key, role = "dlq" })
  kms_key_name               = var.kms_key_id == "" ? null : var.kms_key_id
}

# Publisher SA bindings.
resource "google_pubsub_topic_iam_member" "publisher" {
  for_each = var.publisher_sa_emails

  project = var.project_id
  topic   = google_pubsub_topic.events[each.key].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${each.value}"
}

output "topics" {
  value = { for k, v in google_pubsub_topic.events : k => v.name }
}

output "dlq_topics" {
  value = { for k, v in google_pubsub_topic.dlq : k => v.name }
}
