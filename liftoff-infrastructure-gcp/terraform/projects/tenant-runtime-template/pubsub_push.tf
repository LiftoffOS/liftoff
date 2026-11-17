// -----------------------------------------------------------------------------
// Phase 5: control-plane Pub/Sub PUSH subscriptions for tenant-runtime.
//
// Replaces the streaming-pull pattern in
// `google_pubsub_subscription.control_plane_cross_project_split` (now removed
// in main.tf via a `removed{}` stanza). Reasons:
//
//   1. Streaming pull requires the consumer process to be alive. coordinator-
//      service runs at min-instances=0 in every env, so the subscriber dies
//      whenever Cloud Run scales to zero. Backlog accumulates until the next
//      HTTP request wakes coordinator, and a failure can hide behind exactly
//      this pattern.
//   2. Push delivery scales coordinator on demand: Pub/Sub HTTPs each message
//      to POST /internal/pubsub/<topic>, coordinator cold-starts, processes,
//      scales back to zero. No idle compute, no quiet-period lag.
//
// Reference SA + IAM pattern: liftoff-infrastructure-gcp
// terraform/projects/platform-control/main.tf:1373-1391 (`billing_pubsub_push`).
//
// Coexistence (Gap 9): the existing `sandbox-egress-audit-push-{tenant}-{env}`
// subscription on `control-plane-events-{env}` is unaffected. Pub/Sub fans
// every message out to all subscriptions on a topic, so the new
// `control-plane-events-{env}-coordinator-push` sub coexists naturally — both
// receive every message, no orphan, no conflict.
// -----------------------------------------------------------------------------

// Dedicated SA for Pub/Sub OIDC push auth. Lives in tenant-${tenant_id}-${env}
// — the SAME project as the push subscription — to bypass a Pub/Sub limitation
// where cross-project push-auth SAs trigger a `403: Principal initiating the
// request does not have iam.serviceAccounts.actAs permission` even when the
// caller (or `roles/owner`) has every applicable IAM grant on the SA. Same-
// project actAs validates as expected. The plan originally placed this SA in
// YOUR_GCP_PROJECT alongside the topics, mirroring the
// `billing_pubsub_push` reference pattern; the billing SA happens to be in the
// same project as ITS subscription too — so what looked like a same-vs-cross-
// project distinction was always an in-project requirement.
//
// Coordinator-service's push handler validates that incoming requests carry an
// OIDC token whose `email` claim equals this SA.
// account_id MUST stay <=30 chars (GCP SA constraint
// `^[a-z](?:[-a-z0-9]{4,28}[a-z0-9])$`). The earlier name
// `tenant-runtime-pubsub-push-${env}` was exactly 30 chars at env=dev but
// overflowed at env=prod (31) and env=staging (34). Shortened "runtime" → "rt"
// to fit all envs (dev=24, prod=26, staging=29 chars).
resource "google_service_account" "pubsub_push" {
  project      = google_project.tenant_runtime.project_id
  account_id   = "tenant-rt-pubsub-push-${var.environment}"
  display_name = "Tenant-runtime Pub/Sub Push Invoker — ${var.environment}"
  description  = "SA impersonated by Pub/Sub when pushing control-plane events to coordinator-service in tenant-${var.tenant_id}-${var.environment}"
}

// Pub/Sub service agent must be able to mint OIDC tokens as the push SA. The
// service agent and the SA both live in the tenant project now, so this is a
// same-project grant.
resource "google_service_account_iam_member" "pubsub_push_token_creator" {
  service_account_id = google_service_account.pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.tenant_runtime_for_pubsub.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

// IAM propagation note (Gap 6): GCP IAM grants take 30-90s to propagate
// globally. If terraform creates the push subscription before the
// serviceAccountTokenCreator grant has propagated, Pub/Sub silently fails to
// mint OIDC tokens for the first few delivery attempts and the messages
// either land in the DLQ early or accumulate as undelivered. The
// `time_sleep` here forces a 90s pause between IAM and subscription creation
// on a fresh apply. Subsequent applies are no-ops because time_sleep only
// triggers on resource creation.
resource "time_sleep" "wait_for_push_iam" {
  create_duration = "90s"

  depends_on = [
    google_service_account_iam_member.pubsub_push_token_creator,
  ]
}

// Coordinator-service must accept invocations from the push SA. The push
// handler also validates OIDC at the application layer (audience + email), so
// this is defense-in-depth — Cloud Run IAM rejects at the network edge before
// the request even reaches Express.
resource "google_cloud_run_service_iam_member" "coordinator_invoker_for_push" {
  count    = var.split_services_deployed ? 1 : 0
  project  = google_project.tenant_runtime.project_id
  location = var.region
  service  = "coordinator-service"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

// Multi-step event types — handlers in subscriber.ts that previously called
// `message.modAck(120)` to extend the streaming-pull ack deadline because they
// do non-trivial work (instruction compile + lifecycle activation, etc.).
// Push delivery has no per-message modAck; the ack window is fixed by the
// subscription's `ack_deadline_seconds`. These event types all flow through
// the `control-plane-events` topic (per the comment in subscriber.ts on
// SUBSCRIBED_EVENTS — "Includes ... internal_agent runtime config"), so we
// raise that one topic's ack_deadline to match the old in-code 120s window.
// Other 7 topics carry small handlers that complete in <1s; they keep the
// default 60s.
locals {
  control_plane_push_ack_deadline = {
    "control-plane-events"         = 120
    "tenant-entitlement-updated"   = 60
    "tenant-suspended"             = 60
    "tenant-reactivated"           = 60
    "tenant-deployment-approved"   = 60
    "tenant-model-config-updated"  = 60
    "tenant-prompt-bundle-updated" = 60
    "tenant-feature-flag-updated"  = 60
  }
}

// One push subscription per control-plane topic. Created in the tenant project
// (subscriptions live with the consumer); the topic lives cross-project in
// YOUR_GCP_PROJECT. Naming convention `${topic}-${env}-
// coordinator-push` makes the rename from the old `-coordinator-sub` visible
// in both terraform and Cloud Monitoring filters.
//
// The push_endpoint is a placeholder at terraform-plan time because:
//
//   - On NEW tenant projects, coordinator-service does not exist on first
//     apply, so the URL cannot be resolved.
//   - On EXISTING tenant projects we could resolve via gcloud, but doing so
//     would require a data-source per subscription per apply.
//
// Resolution: `lifecycle { ignore_changes = [push_config] }` makes terraform
// authoritative for everything EXCEPT the push endpoint, and a cloudbuild
// step `patch-push-sub-endpoints` (in tenant-runtime/cloudbuild.yaml, after
// `patch-split-service-urls`) writes the live coordinator URL into each
// subscription with `gcloud pubsub subscriptions update --push-endpoint=...
// --push-auth-service-account=... --push-auth-token-audience=...`. Same
// pattern already used for split-service peer URLs.
resource "google_pubsub_subscription" "control_plane_push" {
  for_each = toset(local.control_plane_subscription_topics)

  project = google_project.tenant_runtime.project_id
  name    = "${each.value}-${var.environment}-coordinator-push"
  topic   = "projects/YOUR_GCP_PROJECT${var.environment}/topics/${each.value}-${var.environment}"

  ack_deadline_seconds       = local.control_plane_push_ack_deadline[each.value]
  message_retention_duration = "604800s"

  push_config {
    // Placeholder — cloudbuild patch step writes the real URL on every apply.
    push_endpoint = "https://placeholder.invalid/internal/pubsub/${each.value}"

    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = "https://placeholder.invalid"
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  expiration_policy {
    ttl = ""
  }

  // MUST match MAX_DELIVERY_ATTEMPTS in subscriber.ts. After 10 attempts
  // (~30 min of exponential backoff via the retry policy above), Pub/Sub
  // auto-routes the message to the DLQ topic created in
  // agent_creation_resilience.tf.
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.control_plane_dlq[each.value].id
    max_delivery_attempts = 10
  }

  labels = {
    environment  = var.environment
    tenant_id    = var.tenant_id
    type         = "cross-project-push"
    source_topic = each.value
    service_type = "coordinator"
  }

  // The cloudbuild patch step is authoritative for push_config. Without
  // this, every terraform apply would revert the live endpoint back to the
  // placeholder and break message delivery until the next deploy.
  lifecycle {
    ignore_changes = [push_config]
  }

  depends_on = [
    google_project_service.apis,
    time_sleep.wait_for_push_iam,
    google_pubsub_topic_iam_member.control_plane_topic_viewer,
  ]
}

// Pub/Sub service agent on the SUBSCRIPTION side needs subscriber on each
// push sub so it can ack on behalf of the consumer (mirrors the equivalent
// grant in agent_creation_resilience.tf — `control_plane_dlq_subscriber_split`,
// now removed via a `removed{}` block since it referenced the deleted pull sub).
resource "google_pubsub_subscription_iam_member" "control_plane_push_subscriber" {
  for_each = toset(local.control_plane_subscription_topics)

  project      = google_project.tenant_runtime.project_id
  subscription = google_pubsub_subscription.control_plane_push[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.tenant_runtime_for_pubsub.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}
