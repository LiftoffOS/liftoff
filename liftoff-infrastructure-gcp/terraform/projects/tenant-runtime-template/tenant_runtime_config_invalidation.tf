// -----------------------------------------------------------------------------
// tenant_runtime_config invalidation — cross-project pull subscription.
//
// platform-backend publishes to
// projects/YOUR_GCP_PROJECT/topics/tenant-runtime-config-updated-${env}
// (defined in terraform/projects/platform-control/main.tf) whenever a tenant's
// runtime config changes. Each tenant project pulls the invalidation here and
// drops its cached runtime config.
//
// Cross-project ref pattern mirrors `control_plane_topic_viewer` (main.tf) and
// the push subscriptions in pubsub_push.tf:
//   - subscription lives in the CONSUMER project (google_project.tenant_runtime)
//   - topic is referenced by fully-qualified cross-project path string
//   - cross-project subscriptions require roles/pubsub.viewer on the source topic
//
// IAM note: the existing `control_plane_topic_viewer` grants pubsub.viewer to
// the tenant project's COMPUTE service account. This wiring instead grants both
// roles to the tenant-runtime SA (module.iam.tenant_runtime_sa) per spec, since
// the config-invalidation consumer authenticates as that SA, not the compute SA.
// -----------------------------------------------------------------------------

resource "google_pubsub_subscription" "tenant_runtime_config_updated_sub" {
  project = google_project.tenant_runtime.project_id
  name    = "tenant-runtime-config-updated-sub-${var.tenant_id}"
  topic   = "projects/YOUR_GCP_PROJECT${var.environment}/topics/tenant-runtime-config-updated-${var.environment}"

  ack_deadline_seconds       = 20
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
    google_pubsub_topic_iam_member.tenant_runtime_config_topic_viewer,
  ]
}

// Cross-project subs require viewer on the source topic in the control project.
resource "google_pubsub_topic_iam_member" "tenant_runtime_config_topic_viewer" {
  project = "YOUR_GCP_PROJECT${var.environment}"
  topic   = "tenant-runtime-config-updated-${var.environment}"
  role    = "roles/pubsub.viewer"
  member  = "serviceAccount:${module.iam.tenant_runtime_sa}"
}

// Tenant-runtime SA must be able to pull + ack from the subscription.
resource "google_pubsub_subscription_iam_member" "tenant_runtime_config_subscriber" {
  project      = google_project.tenant_runtime.project_id
  subscription = google_pubsub_subscription.tenant_runtime_config_updated_sub.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${module.iam.tenant_runtime_sa}"
}
