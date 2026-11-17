# Daily Cloud Scheduler — invokes liftoff-billing's
# /api/internal/jobs/referral-credit-maintenance endpoint at 08:00 UTC.
#
# The two things that happen to referral credit purely because time passed:
#
#   VESTING — a credit earned on a referred workspace's first full-priced paid
#   invoice is `pending` for 60 days. That hold is what makes a flat $20 reward
#   safe: Core is $20/month, so earning $20 costs the referred side two paid
#   months, and self-referral and circular rings lose money by construction.
#   Nothing else flips it to `granted`, so WITHOUT THIS JOB no referral credit
#   ever becomes spendable and the whole referrer half of the programme is
#   inert — earned, recorded, and permanently unusable.
#
#   EXPIRY — vested credit nobody spent is reversed at its `expires_at`, which
#   is max(available_at + 90 days, the holder's next invoice). The floor is
#   there because Liftoff sells annual billing and a bare 90 day timer would
#   expire an annual subscriber's credit before their next invoice could ever
#   consume it.
#
# One job, vesting first, because vesting is what stamps the expiry date: run
# the other way round and a credit that vests today waits a full extra day
# before anything checks the expiry it was just given.
#
# 08:00 UTC, an hour before the card-expiring reminders, so the two daily
# billing jobs do not contend for the same pool. The work is small — a scan of
# `pending` credits past their hold and `granted` ones past their expiry — and
# both halves are idempotent: vesting only touches rows still `pending`, expiry
# only rows still `granted` and unapplied. A retry re-runs safely, which is why
# retry_count 3 matches its neighbours.

resource "google_cloud_scheduler_job" "billing_referral_credit_maintenance_daily" {
  count = var.enabled ? 1 : 0

  project     = var.project_id
  name        = "billing-referral-credit-maintenance-daily-${var.environment}"
  description = "Daily 08:00 UTC: vest referral credit past its 60-day hold, expire vested credit nobody spent"
  region      = var.region
  schedule    = "0 8 * * *"
  time_zone   = "Etc/UTC"

  http_target {
    uri         = "${google_cloud_run_v2_service.billing[0].uri}/api/internal/jobs/referral-credit-maintenance"
    http_method = "POST"

    headers = {
      "X-Service-Auth" = var.billing_service_token
      "Content-Type"   = "application/json"
    }

    body = base64encode("{}")

    oidc_token {
      service_account_email = var.scheduler_service_account_email
      audience              = google_cloud_run_v2_service.billing[0].uri
    }
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "60s"
    max_backoff_duration = "600s"
  }
}
