// -----------------------------------------------------------------------------
// correction.requested — cross-project pull subscription.
//
// platform-backend publishes correction events onto its shared
// projects/YOUR_GCP_PROJECT/topics/control-plane-events-${env}
// topic when someone asks for an executed action to be corrected. The tenant
// runtime consumes them in src/corrections/subscriber.ts and runs the
// compensating tool call.
//
// Until this existed there was no subscription of any kind for those events, so
// Pub/Sub discarded them at publish: the request was accepted by the API,
// recorded in correction history, and then simply never executed.
//
// Same cross-project shape as tenant_runtime_config_invalidation.tf:
//   - subscription lives in the CONSUMER project
//   - topic referenced by fully-qualified path
//   - requires roles/pubsub.viewer on the source topic
//
// The filter narrows a busy shared topic to the two event types this runtime
// consumes. It deliberately does NOT filter on tenant.
//
// `var.tenant_id` is the tenant SLUG ("liftoffos"), while the tenantId attribute
// the control plane publishes is the tenant UUID. A predicate comparing the two
// matches nothing and would silently drop every correction — the exact failure
// this subscription exists to end. Tenant isolation is enforced in the runtime
// instead (src/corrections/subscriber.ts), which resolves its real tenant UUID
// from its own database and refuses anything else. That check is code, so it is
// testable and cannot drift the way a filter string can.
// -----------------------------------------------------------------------------

resource "google_pubsub_subscription" "correction_events_sub" {
  project = google_project.tenant_runtime.project_id
  name    = "correction-events-${var.tenant_id}"
  topic   = "projects/YOUR_GCP_PROJECT${var.environment}/topics/control-plane-events-${var.environment}"

  # Single line on purpose: the API validates this against ^.{0,256}$, and `.`
  # does not match a newline, so a heredoc's trailing newline fails the regex.
  filter = "attributes.eventType = \"correction.requested\" OR attributes.eventType = \"correction.bulk_requested\""

  # Corrections run a real tool call against a vendor; give the handler room to
  # finish before redelivery rather than double-firing a compensating action.
  ack_deadline_seconds       = 120
  message_retention_duration = "604800s" # 7 days

  expiration_policy {
    ttl = "" # never expire
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  labels = {
    environment = var.environment
    tenant_id   = var.tenant_id
    type        = "cross-project-pull"
  }

  depends_on = [
    google_project_service.apis,
    google_pubsub_topic_iam_member.control_plane_events_topic_viewer,
  ]
}

// Cross-project subs require viewer on the source topic in the control project.
resource "google_pubsub_topic_iam_member" "control_plane_events_topic_viewer" {
  project = "YOUR_GCP_PROJECT${var.environment}"
  topic   = "control-plane-events-${var.environment}"
  role    = "roles/pubsub.viewer"
  member  = "serviceAccount:${module.iam.tenant_runtime_sa}"
}

// The retry path republishes the event with an incremented retry count, back to
// the same control-plane topic. Without publisher rights every retry fails on
// permissions instead of retrying.
resource "google_pubsub_topic_iam_member" "control_plane_events_topic_publisher" {
  project = "YOUR_GCP_PROJECT${var.environment}"
  topic   = "control-plane-events-${var.environment}"
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${module.iam.tenant_runtime_sa}"
}

// Tenant-runtime SA must be able to pull + ack from the subscription.
resource "google_pubsub_subscription_iam_member" "correction_events_subscriber" {
  project      = google_project.tenant_runtime.project_id
  subscription = google_pubsub_subscription.correction_events_sub.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${module.iam.tenant_runtime_sa}"
}
