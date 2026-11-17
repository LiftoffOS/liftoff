# billing: variables
# Cloud Run deployment for liftoff-billing (Phase 1 of platform-backend decomposition).

variable "project_id" {
  description = "GCP project ID (typically YOUR_GCP_PROJECT)."
  type        = string
}

variable "environment" {
  description = "Environment name (dev, prod)."
  type        = string
}

variable "region" {
  description = "GCP region. Hard-coded to us-west1 across the platform."
  type        = string
  default     = "us-west1"
}

variable "billing_account" {
  description = "GCP billing account used for labels / cost attribution."
  type        = string
}

# ── Shared Cloud SQL on control-plane-pg ──────────────────────────────────────
variable "control_plane_sql_instance" {
  description = "Name of the shared control-plane-pg Cloud SQL instance (e.g. control-plane-pg-dev)."
  type        = string
}

variable "control_plane_sql_connection_name" {
  description = "Cloud SQL connection name for the shared control-plane-pg instance (project:region:instance)."
  type        = string
}

# ── Shared KMS keyring (keyring-${env}) ───────────────────────────────
variable "kms_key_ring_id" {
  description = "Full resource ID of the shared keyring-{env} KMS keyring where the billing-key will be created."
  type        = string
}

# ── Networking ────────────────────────────────────────────────────────────────
variable "network_id" {
  description = "VPC network ID for Cloud Run egress / private Cloud SQL."
  type        = string
}


# ── Callers ───────────────────────────────────────────────────────────────────
variable "platform_backend_sa_email" {
  description = "Platform Backend SA email — granted roles/run.invoker on the private billing service."
  type        = string
}

variable "platform_backend_url" {
  description = "Platform Backend Cloud Run URL — passed as PLATFORM_BACKEND_URL so billing can call PB's /api/internal/billing/* HMAC endpoints (getControlsStatus, subscription-activated, etc.). Empty string disables PB calls; current-usage then falls back to NO_USAGE_DEFAULT and the dashboard shows the unprovisioned-tenant shape."
  type        = string
  default     = ""
}

# ── Image / enablement ────────────────────────────────────────────────────────
variable "image_sha" {
  description = "SHA-only image tag (short SHA) published by cloudbuild. Placeholder until the first successful build."
  type        = string
  # TODO: image SHA when liftoff-billing first builds.
  default = "placeholder"
}

variable "migration_image_sha" {
  description = "SHA-only image tag for the billing-migration container (backfill, replication, cutover-runner)."
  type        = string
  default     = "placeholder"
}

variable "enabled" {
  description = "When false, only SA/IAM/DB/KMS/secret plumbing is created; Cloud Run service + invoker IAM are skipped."
  type        = bool
  default     = false
}

variable "min_instances" {
  description = "Cloud Run min-instances. Billing runs at 0 (plan 0d)."
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Cloud Run max-instances."
  type        = number
  default     = 10
}

variable "db_app_password" {
  description = "Password for the billing_app SQL user. Sourced from a random_password in the parent config."
  type        = string
  sensitive   = true
}

variable "db_migrate_password" {
  description = "Password for the billing_migrate SQL user (DDL-only, owned by the migrate job)."
  type        = string
  sensitive   = true
}

variable "db_readonly_password" {
  description = "Password for the billing_readonly SQL user."
  type        = string
  sensitive   = true
}

variable "billing_events_dlq_topic_id" {
  description = "Fully-qualified Pub/Sub topic ID for the billing-events DLQ (created by pubsub-events module)."
  type        = string
  default     = ""
}

variable "notification_channels" {
  description = "Cloud Monitoring notification channel IDs attached to burn-rate alerts."
  type        = list(string)
  default     = []
}

variable "binary_authorization_enabled" {
  description = "Whether to create the per-service Binary Authorization attestor. Defaults true."
  type        = bool
  default     = true
}

variable "cloud_build_trigger_enabled" {
  description = "Whether to create the Cloud Build trigger. Set true only once the GitHub App connection and builder service account are confirmed in the target project."
  type        = bool
  default     = false
}

variable "stripe_ou_price_id" {
  # Telemetry-only: the meter is a usage dimension, so this price is $0.00 and
  # the money comes from the subscription line items and reload invoices. Empty
  # (the default) attaches no OU item at all.
  # Priced predecessors are archived in both Stripe modes and their ids are
  # deliberately not named here -- reinstating one would double-charge prepaid
  # consumption.
  description = "Stripe Price ID for the operating_unit_consumed meter item (telemetry-only, $0.00). Passed as STRIPE_OU_PRICE_ID to the billing services so new customers get the OU meter item attached at checkout."
  type        = string
  default     = ""
}

# ── Self-serve plan persistent price IDs ──────────────────────────────────────
# One template price per (plan, billing period). The billing service reads
# `<price>.product` from each to resolve the persistent product ID that every
# self-serve ad-hoc price attaches to (uniform invoice line text + stable
# anchor for coupon `applies_to.products` scoping). Per-customer pricing is
# still computed at /subscribe time via `unit_amount`; these prices are
# product-identity anchors only and their `unit_amount` is not used for
# customer billing.

variable "stripe_plan_core_monthly_price_id" {
  description = "Persistent Stripe price ID for the Core monthly plan; its parent product is the anchor for the ad-hoc per-customer price on /subscribe."
  type        = string
  default     = ""
}

variable "stripe_plan_core_annual_price_id" {
  description = "Persistent Stripe price ID for the Core annual plan."
  type        = string
  default     = ""
}

variable "stripe_plan_growth_monthly_price_id" {
  description = "Persistent Stripe price ID for the Growth monthly plan."
  type        = string
  default     = ""
}

variable "stripe_plan_growth_annual_price_id" {
  description = "Persistent Stripe price ID for the Growth annual plan."
  type        = string
  default     = ""
}

variable "stripe_plan_scale_monthly_price_id" {
  description = "Persistent Stripe price ID for the Scale monthly plan."
  type        = string
  default     = ""
}

variable "stripe_plan_scale_annual_price_id" {
  description = "Persistent Stripe price ID for the Scale annual plan."
  type        = string
  default     = ""
}

# ── Card-expiring scheduler wiring ────────────────────────────────────────────
# Shared X-Service-Auth token sent by Cloud Scheduler to the billing service's
# /api/internal/jobs/card-expiring-reminders endpoint. Matches the token the
# billing service validates against (billingServiceToken in server.ts).
variable "billing_service_token" {
  description = "Shared X-Service-Auth secret value used by the card-expiring scheduler to authenticate to liftoff-billing's internal job endpoint."
  type        = string
  sensitive   = true
  default     = ""
}

# Scheduler SA used as OIDC identity for the daily card-expiring Cloud Scheduler
# job. Mirrors the pattern in platform-control schedulers.
variable "scheduler_service_account_email" {
  description = "Service account used as the OIDC identity for billing-module Cloud Scheduler jobs."
  type        = string
  default     = ""
}

variable "vpc_network_id" {
  description = "VPC network for Direct VPC egress (replaces the Serverless VPC Access connector)."
  type        = string
}

variable "vpc_subnetwork_id" {
  description = "Subnetwork Cloud Run takes egress IPs from (Direct VPC egress)."
  type        = string
}
