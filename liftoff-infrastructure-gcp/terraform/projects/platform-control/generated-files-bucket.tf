# Object storage for generated_files — the artifacts a person can see.
#
# Every path through platform-backend's generated-files service — a document an
# agent authored (xlsx / docx / pptx), an Anchor snapshot of a browser page, a
# file downloaded inside a browser session, and the media an agent shows a
# person — calls `storage.bucket(...).save()` against `generated-files-${env}`,
# and fails with "The specified bucket does not exist." without this.
#
# The failure can stay invisible: the tenant runtime is the only out-of-process
# producer, and if its upload client does not send X-Service-Auth, every upload
# is refused with a 401 at the application layer before it can discover a
# missing bucket.
#
# Three things are needed. A bucket is not enough on its own:
#
#   1. The bucket.
#   2. Object permissions. The platform-backend service account holds no other
#      storage role, so even with a bucket it could neither write nor read.
#   3. The ability to SIGN. Every read of an artifact goes out as a V4 signed
#      URL, and a service account on Cloud Run has no private key — the client
#      falls back to the IAM SignBlob API, which requires the account to be a
#      token creator ON ITSELF. Without it the bucket and the objects exist and
#      every download 500s instead, which is a worse failure than this one
#      because the bytes are already stored by then.
#
# No lifecycle rule, deliberately. The sibling buckets in this project expire
# their contents because they hold telemetry; these are things a person made or
# was shown, and a thread that renders a picture is a permanent record. Inbound
# uploads that no message ever claimed are swept by
# sweep-abandoned-uploads (see chat-media-sweep-scheduler.tf), which deletes on
# a claim marker rather than on age alone — age would delete the artifact of
# every conversation older than the window.

resource "google_storage_bucket" "generated_files" {
  project  = google_project.platform_control.project_id
  name     = "generated-files-${var.environment}"
  location = "US-WEST1"

  uniform_bucket_level_access = true
  # Objects reach a browser only through a short-lived signed URL minted behind
  # a Firebase-authenticated, tenant-membership-checked route. Nothing here is
  # ever meant to be world-readable, so the door is closed at the bucket rather
  # than relying on every future object write to get its ACL right.
  public_access_prevention = "enforced"

  versioning {
    enabled = false
  }

  depends_on = [google_project_service.apis]
}

# Read, write and delete objects. Scoped to this bucket rather than granted at
# the project, so the backend gaining object access here does not also hand it
# the audit-log, billing-cold-storage and data-export buckets in the same
# project.
#
# objectAdmin rather than objectCreator: the retention sweep DELETES abandoned
# uploads, and the download route reads.
resource "google_storage_bucket_iam_member" "generated_files_backend" {
  bucket = google_storage_bucket.generated_files.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.platform_backend.email}"
}

# Let the backend sign URLs as itself.
#
# `getSignedUrl()` needs a private key. There is none on Cloud Run, so the
# Storage client signs through the IAM credentials API instead, and that call is
# `signBlob` on the service account's OWN identity — which is why the member and
# the resource here are the same account. This is the standard grant for
# keyless V4 signing and it is what makes a download route possible without
# putting a JSON key in a secret.
resource "google_service_account_iam_member" "platform_backend_self_signer" {
  service_account_id = google_service_account.platform_backend.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.platform_backend.email}"
}
