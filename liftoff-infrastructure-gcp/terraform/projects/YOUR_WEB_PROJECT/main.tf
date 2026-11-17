# Liftoff Website Project
# Owns: Cloud Run (liftoff-react)
# GCP project: YOUR_WEB_PROJECT

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
    # Cloudflare DNS for the public-host load balancer (public_lb.tf). The
    # provider is configured in the prod root, the only root that instantiates
    # this module.
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

# ─── Variables ────────────────────────────────────────────────────────────────

variable "project_id" {
  type        = string
  description = "GCP project ID for the website project"
  default     = "YOUR_WEB_PROJECT"
}

variable "region" {
  type        = string
  description = "Primary region"
  default     = "us-west1"
}

variable "ci_cloud_build_sa_email" {
  type        = string
  description = "Cloud Build SA email from the platform-ci project. Grants secretmanager.viewer so Terraform can refresh state of secrets in this project."
  default     = ""
}

variable "firebase_auth_viewer_sa_emails" {
  type        = list(string)
  default     = []
  description = <<-EOT
    Service accounts (from other projects) that need to call Identity Toolkit
    APIs against this project's Firebase Auth — granted roles/firebaseauth.viewer.

    Required for any backend that calls verifyIdToken(token, checkRevoked=true)
    via the Firebase Admin SDK. Without this binding, every authenticated request
    fails with auth/insufficient-permission and the dashboard returns 401 on
    every call.

    Typically platform-backend-{env} from YOUR_GCP_PROJECT.
  EOT
}

variable "firebase_cloud_messaging_sender_sa_emails" {
  type        = list(string)
  default     = []
  description = <<-EOT
    Service accounts (from other projects) that need to SEND Firebase Cloud
    Messaging messages for this project — granted
    roles/firebasecloudmessaging.admin, the role carrying
    cloudmessaging.messages.create.

    Note this is NOT roles/firebasenotifications.admin ("Firebase Cloud
    Messaging Admin"), which looks right by title but only covers the legacy
    console-campaigns API (firebasenotifications.messages.*). The Admin SDK's
    getMessaging().send* calls hit fcm.googleapis.com/v1/projects/<id>/messages:send,
    which checks cloudmessaging.messages.create.

    Required for browser push notifications: the token is minted against this
    project's sender ID, so the send has to target THIS project even though
    platform-backend runs in another one. Without this binding every send fails
    with a 403 that names neither push nor the missing role.

    Typically platform-backend-{env} from YOUR_GCP_PROJECT.
  EOT
}

variable "firebase_remote_config_viewer_sa_emails" {
  type        = list(string)
  default     = []
  description = <<-EOT
    Service accounts (from other projects) that need to read this project's
    Firebase Remote Config template — granted roles/cloudconfig.viewer
    (Firebase Remote Config Viewer; the curated role uses the `cloudconfig`
    prefix, not `firebaseremoteconfig`).

    Required for platform-backend's access gate, which loads `allowed_domains`
    from Remote Config via the Admin SDK (see src/config/allowedDomains.ts).
    Without this binding the SDK call returns permission-denied and the cache
    silently falls back to the hardcoded `example.com` only — locking out
    every other approved domain.

    Typically platform-backend-{env} from YOUR_GCP_PROJECT.
  EOT
}

# ─── Data ─────────────────────────────────────────────────────────────────────

data "google_project" "website" {
  project_id = var.project_id
}

# ─── Enabled APIs ─────────────────────────────────────────────────────────────
# Identity Toolkit is required by Firebase Admin SDK calls that take
# checkRevoked=true (added by platform-backend's Log Out All Devices feature,
# commit 240561b). Without it, verifyIdToken throws auth/internal-error.

resource "google_project_service" "identity_toolkit" {
  project            = var.project_id
  service            = "identitytoolkit.googleapis.com"
  disable_on_destroy = false
}

# Required so platform-backend can read this project's Remote Config template
# (the `allowed_domains` parameter that gates dashboard access).
# Required so platform-backend can send push notifications for this project.
# The token lives against this project's sender, so the send targets this
# project even though the caller runs elsewhere.
resource "google_project_service" "fcm" {
  project            = var.project_id
  service            = "fcm.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "firebase_remote_config" {
  project            = var.project_id
  service            = "firebaseremoteconfig.googleapis.com"
  disable_on_destroy = false
}

# ─── IAM: cross-project firebaseauth.viewer ───────────────────────────────────
# Grants roles/firebaseauth.viewer (the minimal role with firebaseauth.users.get)
# to each platform-backend service account so verifyIdToken(token, checkRevoked)
# can look up the user's tokensValidAfterTime.

resource "google_project_iam_member" "firebase_auth_viewer" {
  for_each = toset(var.firebase_auth_viewer_sa_emails)
  project  = var.project_id
  role     = "roles/firebaseauth.viewer"
  member   = "serviceAccount:${each.key}"

  depends_on = [google_project_service.identity_toolkit]
}

# ─── IAM: cross-project Firebase Remote Config Viewer ────────────────────────
# Grants roles/cloudconfig.viewer (the curated Firebase Remote Config Viewer
# role — its internal name uses the `cloudconfig` prefix, not
# `firebaseremoteconfig`) to each platform-backend service account so the
# Admin SDK's getRemoteConfig().getServerTemplate() call can read
# `allowed_domains`.

resource "google_project_iam_member" "firebase_remote_config_viewer" {
  for_each = toset(var.firebase_remote_config_viewer_sa_emails)
  project  = var.project_id
  role     = "roles/cloudconfig.viewer"
  member   = "serviceAccount:${each.key}"

  depends_on = [google_project_service.firebase_remote_config]
}

# ─── IAM: cross-project Firebase Cloud Messaging sender ──────────────────────
# Grants roles/firebasecloudmessaging.admin to each platform-backend service
# account so getMessaging().sendEachForMulticast() can deliver browser push.
#
# Cross-project because dev and prod share one Firebase project: the FCM token
# a browser mints is bound to this project's sender ID, so the send must target
# YOUR_WEB_PROJECT while the caller is platform-backend-{env} in
# YOUR_GCP_PROJECT. Verifying an ID token needs no binding at all
# (public JWKS), which is why auth has worked without this and sending will not.

resource "google_project_iam_member" "firebase_cloud_messaging_sender" {
  for_each = toset(var.firebase_cloud_messaging_sender_sa_emails)
  project  = var.project_id
  role     = "roles/firebasecloudmessaging.admin"
  member   = "serviceAccount:${each.key}"

  depends_on = [google_project_service.fcm]
}

resource "google_project_iam_member" "ci_cloud_build_editor" {
  count   = var.ci_cloud_build_sa_email != "" ? 1 : 0
  project = var.project_id
  role    = "roles/editor"
  member  = "serviceAccount:${var.ci_cloud_build_sa_email}"
}

resource "google_project_iam_member" "ci_cloud_build_secretmanager_admin" {
  count   = var.ci_cloud_build_sa_email != "" ? 1 : 0
  project = var.project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${var.ci_cloud_build_sa_email}"
}

# ─── Outputs ─────────────────────────────────────────────────────────────────

# ─── Cloud Build: deploy permissions for the liftoff-react-builder SA ────────
# Cloud Build in this project uses the user-managed `liftoff-react-builder`
# SA, NOT the default Cloud Build SA. All IAM bindings must reference this SA.
# Project-level serviceAccountUser lets it deploy Cloud Run revisions that run
# as this project's service accounts.

locals {
  builder_sa = "serviceAccount:liftoff-react-builder@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "builder_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = local.builder_sa
}

resource "google_project_iam_member" "builder_act_as_service_accounts" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = local.builder_sa
}

resource "google_project_iam_member" "builder_artifact_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = local.builder_sa
}
