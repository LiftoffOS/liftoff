// Module-level provider declarations.
//
// `google.platform_control` is an aliased configuration that the calling env
// module passes in via the `providers = { google.platform_control = ... }`
// block. Used by `pubsub_push.tf` to create the dedicated push SA in
// YOUR_GCP_PROJECT (separate project from the tenant project
// where everything else in this module lives).
//
// `time` is needed by `time_sleep.wait_for_push_iam` in pubsub_push.tf to
// pause for IAM propagation between the token-creator grant and the push
// subscription creation.

terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source                = "hashicorp/google"
      version               = ">= 5.25, < 6.0"
      configuration_aliases = [google.platform_control]
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 5.25, < 6.0"
    }
    time = {
      source  = "hashicorp/time"
      version = ">= 0.9"
    }
    # Used by anchor_webhook_receiver_domain.tf to publish the CNAME for
    # the receiver's stable hostname (anchor-webhooks{,-dev}.example.com).
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}
