// WS-9.2 — Gmail users.watch publishes history notifications to this topic;
// Pub/Sub push delivers them to tenant-runtime's /api/internal/gmail-history-push
// endpoint with an OIDC token.

resource "google_pubsub_topic" "gmail_history" {
  count   = var.tenant_runtime_deployed ? 1 : 0
  project = google_project.tenant_runtime.project_id
  name    = "gmail-history-${var.environment}"

  message_retention_duration = "86400s" # 24h
}

// Gmail's well-known publisher SA (per Google's documented contract).
// The gmail-api-push@system.gserviceaccount.com SA is provided by Google's
// system.gserviceaccount.com domain. Org Policy
// `constraints/iam.allowedPolicyMemberDomains` rejects principals from
// non-allowlisted domains; production environments commonly block
// system.gserviceaccount.com. When that's the case, deploy this binding
// out-of-band (or grant the binding via a temporary org-policy exception)
// and leave the gate flipped off so a plain `terraform apply` doesn't
// re-fail. Dev typically has the policy disabled.
variable "gmail_publisher_iam_enabled" {
  description = "Grant gmail-api-push@system.gserviceaccount.com publisher access to the gmail-history topic. Disable in environments where iam.allowedPolicyMemberDomains rejects system.gserviceaccount.com."
  type        = bool
  default     = false
}

resource "google_pubsub_topic_iam_member" "gmail_publisher" {
  count   = var.tenant_runtime_deployed && var.gmail_publisher_iam_enabled ? 1 : 0
  project = google_project.tenant_runtime.project_id
  topic   = google_pubsub_topic.gmail_history[0].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:gmail-api-push@system.gserviceaccount.com"
}

// DLQ topic for gmail history push deliveries that exceed max attempts.
resource "google_pubsub_topic" "gmail_history_dlq" {
  count   = var.tenant_runtime_deployed ? 1 : 0
  project = google_project.tenant_runtime.project_id
  name    = "gmail-history-${var.environment}-dlq"

  message_retention_duration = "604800s" # 7d
}

resource "google_pubsub_subscription" "gmail_history_push" {
  count                = var.tenant_runtime_deployed ? 1 : 0
  project              = google_project.tenant_runtime.project_id
  name                 = "gmail-history-${var.environment}-push"
  topic                = google_pubsub_topic.gmail_history[0].name
  ack_deadline_seconds = 60

  push_config {
    push_endpoint = "${data.google_cloud_run_v2_service.tenant_runtime[0].uri}/api/internal/gmail-history-push"
    oidc_token {
      service_account_email = "tenant-${var.tenant_id}-runtime@tenant-${var.tenant_id}-${var.environment}.iam.gserviceaccount.com"
      audience              = data.google_cloud_run_v2_service.tenant_runtime[0].uri
    }
    attributes = {
      "x-goog-version" = "v1"
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.gmail_history_dlq[0].id
    max_delivery_attempts = 10
  }

  expiration_policy {
    ttl = "" # never expire
  }
}

// Allow Pub/Sub to ack messages on this subscription as part of the
// dead-letter policy (per Google docs).
resource "google_pubsub_subscription_iam_member" "gmail_history_push_subscriber" {
  count        = var.tenant_runtime_deployed ? 1 : 0
  project      = google_project.tenant_runtime.project_id
  subscription = google_pubsub_subscription.gmail_history_push[0].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${google_project.tenant_runtime.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}
