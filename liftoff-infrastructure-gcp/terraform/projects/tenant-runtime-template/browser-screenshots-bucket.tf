# Anchor browser-session screenshots bucket.
#
# read_active_browser_session / GetPageState capture a PNG screenshot of the
# live Anchor session, upload it here, and hand the agent / dashboard a signed
# URL (10-min TTL). Objects are short-lived — a 1-day lifecycle rule reaps them
# well after any signed URL has expired.
#
# Repo conventions (see main.tf / split_services.tf):
#   - project        → google_project.tenant_runtime.project_id (local.project_id)
#   - tenant-runtime SA email → local.tenant_runtime_sa_email (= module.iam.tenant_runtime_sa)
resource "google_storage_bucket" "browser_screenshots" {
  project                     = google_project.tenant_runtime.project_id
  name                        = "${local.project_id}-browser-screenshots"
  location                    = "US-WEST1"
  uniform_bucket_level_access = true

  lifecycle_rule {
    condition {
      age = 1 # 1-day lifecycle; signed URLs expire at 10 min so 1d is generous
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [
    google_project_service.apis,
  ]
}

resource "google_storage_bucket_iam_member" "browser_screenshots_writer" {
  bucket = google_storage_bucket.browser_screenshots.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${local.tenant_runtime_sa_email}"
}

# V4 signed-URL generation for screenshot delivery. On Cloud Run the tenant-
# runtime SA has no exported private key, so @google-cloud/storage signs URLs
# through the IAM SignBlob API — which requires the SA to be able to mint
# credentials for ITSELF (roles/iam.serviceAccountTokenCreator on its own
# resource). Without this, GetPageState fails at the signing step with
# "Permission 'iam.serviceAccounts.signBlob' denied on resource". The screenshot
# uploads fine (objectAdmin above); only the signing needs this self-grant.
resource "google_service_account_iam_member" "browser_screenshots_signer" {
  service_account_id = "projects/${local.project_id}/serviceAccounts/${local.tenant_runtime_sa_email}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${local.tenant_runtime_sa_email}"
}
