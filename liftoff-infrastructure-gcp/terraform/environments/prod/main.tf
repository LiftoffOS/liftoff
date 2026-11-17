# Production Environment Configuration
# Per Section 2: GCP Layout
# Production is the customer-facing environment with maximum protection

terraform {
  # `removed` block (used in tenant-runtime-template/agent_creation_resilience.tf)
  # requires Terraform >= 1.7.
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.25, < 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 5.25, < 6.0"
    }
    # `time_sleep` in tenant-runtime-template/pubsub_push.tf gates the IAM-
    # propagation pause between push-SA token-creator grant and push sub
    # creation. Pinned for reproducible CI plans.
    time = {
      source  = "hashicorp/time"
      version = ">= 0.9"
    }
    # Cloudflare DNS records for *.tunnels.example.com (tunnel-service).
    # Inert in prod until tunnel_service_enabled is flipped to true.
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }

  backend "gcs" {
    bucket = "YOUR_CI_PROJECT-tfstate"
    prefix = "terraform/state"
  }
}

provider "google" {
  region = var.region
}

# Aliased provider pinned to the platform-control project. Used by the
# tenant-runtime-template module (pubsub_push.tf) when it creates the dedicated
# Pub/Sub push SA in YOUR_GCP_PROJECT.
provider "google" {
  alias   = "platform_control"
  region  = var.region
  project = "YOUR_GCP_PROJECT${var.environment}"
}

provider "google-beta" {
  region = var.region
}

# Cloudflare provider — token is mirrored to both control-dev and control-prod
# SMs (same value, one zone for example.com). Avoids cross-perimeter VPC-SC
# friction; rotation requires updating both SM entries. Inert until
# tunnel_service_enabled = true.
data "google_secret_manager_secret_version" "cloudflare_api_token" {
  count   = var.tunnel_service_enabled ? 1 : 0
  secret  = "cloudflare-dns-edit-token"
  project = "YOUR_GCP_PROJECT${var.environment}"
}

provider "cloudflare" {
  # Inert placeholder when tunnel_service_enabled=false (no resources, no
  # API calls) — provider still requires a syntactically valid token string.
  api_token = var.tunnel_service_enabled ? data.google_secret_manager_secret_version.cloudflare_api_token[0].secret_data : "placeholder_no_calls_made_when_tunnel_service_disabled"
}

# -----------------------------------------------------------------------------
# Variables
# -----------------------------------------------------------------------------

variable "org_id" {
  type        = string
  description = "GCP Organization ID"
}

variable "billing_account" {
  type        = string
  description = "Billing account ID"
}

variable "region" {
  type        = string
  default     = "us-west1"
  description = "Primary region for deployment"
}

variable "environment" {
  type        = string
  default     = "prod"
  description = "Environment name"
}

variable "github_repos_connected" {
  type        = bool
  default     = false
  description = "Set to true after GitHub repos are connected in Cloud Build console"
}

variable "slack_bot_token" {
  type        = string
  sensitive   = true
  description = "Slack Bot OAuth Token (xoxb-...) for #platform-observability-alerts"
  # No default - must be explicitly set for production
}

variable "tenant_runtime_url" {
  type        = string
  default     = ""
  description = "Tenant Runtime Cloud Run service URL for cross-service API calls (set after tenant-runtime is deployed)"
}

variable "x402_low_balance_threshold_usd" {
  description = "USDC balance under which the x402 low-balance check pages; empty = the service default ($10)."
  type        = string
  default     = ""
}

variable "apify_prepaid_token_usd" {
  description = "Size of each Apify prepaid token after the first (USD); empty = the service default ($10)."
  type        = string
  default     = ""
}

variable "x402_wallet_address" {
  type        = string
  description = "The x402 wallet's public address on Base for this environment (empty = wallet not live)"
  default     = ""
}

# Alert notification configuration
variable "alert_email" {
  type        = string
  default     = ""
  description = "Email for alert notifications (defaults to alerts@example.com)"
}

variable "pagerduty_service_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "PagerDuty integration key for on-call escalation"
}

# Phase 0 decomposition service flags — mirrors dev/main.tf
variable "billing_enabled" {
  type    = bool
  default = false
}
variable "billing_image_sha" {
  type    = string
  default = "placeholder"
}
variable "stripe_ou_price_id" {
  # $0.00 by design. The OU meter is a usage DIMENSION, not a charge:
  # docs/runbooks/BILLING_RECONCILIATION.md states that per-tenant pricing is
  # reflected in subscription line items and reload invoices, not in the meter
  # dimension. Every OU bucket is prepaid -- included and precommit are covered
  # by the base monthly fee (included_ous x included_rate equals it to the cent
  # on all three plans), and reload drains the customer's prepaid wallet. A
  # priced meter therefore charges a second time for consumption already paid
  # for.
  #
  # Any earlier priced predecessor should be archived in BOTH Stripe modes
  # (active=false) once its subscription items are migrated to this price.
  # Their ids are deliberately not repeated here: there is no
  # legitimate reason to reach for one, and Stripe has no DELETE for prices, so
  # archived is as retired as they get.
  #
  # Stripe prices are immutable, so correcting the amount means a new price id
  # rather than an edit.
  description = "Stripe Price ID for the operating_unit_consumed meter item (telemetry-only, $0.00)."
  type        = string
  default     = "price_YOUR_STRIPE_ID"
}
variable "developer_proxy_enabled" {
  type    = bool
  default = false
}
variable "developer_proxy_image_sha" {
  type    = string
  default = "placeholder"
}
variable "workforce_enabled" {
  type    = bool
  default = false
}
variable "workforce_image_sha" {
  type    = string
  default = "placeholder"
}
variable "read_replica_enabled" {
  type    = bool
  default = false
}
variable "pgbouncer_enabled" {
  type    = bool
  default = false
}
variable "bigquery_sink_governance_mirror" {
  type    = bool
  default = false
}
variable "audit_anchor_operator_readers" {
  type    = list(string)
  default = []
}

# Self-serve plan persistent price IDs — set in environments/prod/terraform.tfvars.
# The billing service uses each to resolve the parent persistent product that
# ad-hoc per-customer prices attach to (uniform invoice line text + coupon
# `applies_to.products` scoping).
variable "stripe_plan_core_monthly_price_id" {
  type    = string
  default = ""
}
variable "stripe_plan_core_annual_price_id" {
  type    = string
  default = ""
}
variable "stripe_plan_growth_monthly_price_id" {
  type    = string
  default = ""
}
variable "stripe_plan_growth_annual_price_id" {
  type    = string
  default = ""
}
variable "stripe_plan_scale_monthly_price_id" {
  type    = string
  default = ""
}
variable "stripe_plan_scale_annual_price_id" {
  type    = string
  default = ""
}

# MCP OAuth front door (plan v6.1) -----------------------------------------------
variable "mcp_oauth_enabled" {
  description = "Release gate: advertise the MCP OAuth front door (.well-known + WWW-Authenticate challenge). Value flows to platform-control's MCP_OAUTH_ENABLED env. Keep false until a canary in a non-production environment completes."
  type        = string
  default     = "false"
}

# Tunnel service ----------------------------------------------------------------
variable "tunnel_service_enabled" {
  description = "Enable the live tunnel-service Cloud Run + GCLB + Cloudflare DNS stack. Keep false until a smoke test in a non-production environment completes."
  type        = bool
  default     = false
}
variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for example.com. Required when tunnel_service_enabled = true."
  type        = string
  default     = ""
}
variable "tunnel_base_domain" {
  description = "Per-env FQDN that fronts the tunnel terminator. Prod owns the bare tunnels.example.com label; dev uses tunnels-dev.example.com."
  type        = string
  default     = "tunnels.example.com"
}

# Public hosts behind a TLS 1.2+ load balancer.
variable "public_lb_enabled" {
  description = "Provision the platform-control public-host load balancer and take the api/webhooks/connectors/anchor DNS records into Terraform."
  type        = bool
  default     = false
}
variable "run_app_ingress_closed" {
  description = "Close the direct *.run.app path of platform-backend and connector-service (INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER). Only after every caller uses the public hostname."
  type        = bool
  default     = false
}
variable "public_lb_cutover" {
  description = "Per-host cutover flags for platform-control (keys: api, webhooks, connectors, anchor). Flip only once the certificate is ACTIVE."
  type        = map(bool)
  default     = {}
}

# -----------------------------------------------------------------------------
# Platform callback token — shared secret that Cloud Scheduler jobs send in
# the X-Service-Auth header when they invoke /api/internal/* endpoints on
# platform-backend. Read directly from Secret Manager (the canonical store)
# so the X-Service-Auth headers Terraform writes on every scheduler resource
# always match what platform-backend's _serviceAuth.ts validates against.
# Without this, `var.platform_callback_token` defaults to "" and every infra
# apply silently breaks notifications-hourly-tick + every maintenance
# scheduler job (expire-agent-messages, ou-meter-retry-drain, etc.) with 401s.
data "google_secret_manager_secret_version" "platform_callback_token" {
  secret  = "platform-callback-token"
  project = "YOUR_GCP_PROJECT${var.environment}"
}

# Platform Projects
# -----------------------------------------------------------------------------

module "platform_control" {
  source = "../../projects/platform-control"

  # Sub-hourly control jobs fire hourly at :00 while the platform has no
  # traffic, so the services they wake can scale to zero between them.
  idle_cadence = true

  org_id                         = var.org_id
  billing_account                = var.billing_account
  environment                    = var.environment
  region                         = var.region
  slack_bot_token                = var.slack_bot_token
  platform_callback_token        = data.google_secret_manager_secret_version.platform_callback_token.secret_data
  tenant_runtime_url             = var.tenant_runtime_url
  x402_wallet_address            = var.x402_wallet_address
  x402_low_balance_threshold_usd = var.x402_low_balance_threshold_usd
  apify_prepaid_token_usd        = var.apify_prepaid_token_usd

  # Custom domain — stable string, avoids billing↔PB module cycle. Passed
  # through to billing as PLATFORM_BACKEND_URL.
  platform_backend_public_url = "https://api.example.com"

  # Connector service is enabled in prod. Matches dev/main.tf.
  connector_service_enabled = true

  # VPC-SC perimeter around prod connector-service. Access policy
  # 724513199024 ("Liftoff Access Policy") provisioned at the org level
  # via `gcloud access-context-manager policies create`. Allowed caller
  # projects are the tenant runtime projects that need to call
  # connector-service across the perimeter.
  connector_service_security_enabled            = true
  connector_service_security_org_id             = "YOUR_GCP_ORG_ID"
  connector_service_security_access_policy_name = "724513199024"
  # Let in-VPC workloads reach GCS — the agent-diagnostics job writes its
  # scorecard NDJSON sink to gs://YOUR_GCP_PROJECT through the connector.
  connector_service_security_extra_vpc_services = ["storage.googleapis.com"]
  connector_service_security_allowed_caller_projects = [
    "703988713386", # YOUR_TENANT_PROJECT
  ]
  # Keep admin + automation access to prod resources through the VPC-SC
  # perimeter. Without this, `gcloud ...` from a workstation and
  # `terraform apply` from Cloud Build are both blocked on restricted
  # services (Secret Manager, Cloud Run, Cloud Functions).
  #
  # The two tenant/platform runtime SAs are included because both read
  # the cross-project `connector-service-token` / `governance-engine-token`
  # secrets from `YOUR_CONTROL_PROJECT` at boot (see
  # `SECRET_MANIFEST` in tenant-runtime's `src/infrastructure/secrets.ts`).
  # Without access-level membership VPC-SC rejects the Secret Manager
  # read with PERMISSION_DENIED, the token isn't set in process.env, and
  # every Connect-RPC call to connector-service / governance-engine
  # arrives with no `X-Service-Auth` header and gets 401'd at the
  # `verifyServiceAuth` middleware — surfacing in tenant-runtime as
  # `tool_schema_cache_refresh_failed [unauthenticated]` and in the
  # user-visible Claude Coder agent as "no MCP tools available".
  connector_service_security_admin_members = [
    "user:person@example.com",
    "serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
    "serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
    "serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
    "serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
    "serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
    "serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
    "serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
    "serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
  ]

  # Phase 0 decomposition — pass image SHAs and enable flags through.
  billing_enabled           = var.billing_enabled
  billing_image_sha         = var.billing_image_sha
  stripe_ou_price_id        = var.stripe_ou_price_id
  developer_proxy_enabled   = var.developer_proxy_enabled
  developer_proxy_image_sha = var.developer_proxy_image_sha
  workforce_enabled         = var.workforce_enabled
  workforce_image_sha       = var.workforce_image_sha

  read_replica_enabled            = var.read_replica_enabled
  pgbouncer_enabled               = var.pgbouncer_enabled
  bigquery_sink_governance_mirror = var.bigquery_sink_governance_mirror
  audit_anchor_operator_readers   = var.audit_anchor_operator_readers

  stripe_plan_core_monthly_price_id   = var.stripe_plan_core_monthly_price_id
  stripe_plan_core_annual_price_id    = var.stripe_plan_core_annual_price_id
  stripe_plan_growth_monthly_price_id = var.stripe_plan_growth_monthly_price_id
  stripe_plan_growth_annual_price_id  = var.stripe_plan_growth_annual_price_id
  stripe_plan_scale_monthly_price_id  = var.stripe_plan_scale_monthly_price_id
  stripe_plan_scale_annual_price_id   = var.stripe_plan_scale_annual_price_id

  # Tunnel service — disabled in prod until dev smoke-test completes.
  tunnel_service_enabled = var.tunnel_service_enabled
  cloudflare_api_token   = var.tunnel_service_enabled ? data.google_secret_manager_secret_version.cloudflare_api_token[0].secret_data : ""
  cloudflare_zone_id     = var.cloudflare_zone_id
  tunnel_base_domain     = var.tunnel_base_domain

  # Phase 3: governance-engine enabled.
  # Set true once the first Cloud Build has published the image and created
  # the Cloud Run service; Terraform then manages IAM + bindings on the
  # adopted service. VPC-SC for
  # governance-engine remains deferred until the perimeter design is
  # finalized; the dedicated governance access level is an orthogonal
  # follow-up.
  governance_engine_enabled = true

  # Phase 3: tenant-runtime SAs that subscribe to governance-events-prod.
  allowed_governance_subscribers = [
    "YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
  ]

  # MCP OAuth front door (plan v6.1 Phase 6 gate)
  mcp_oauth_enabled = var.mcp_oauth_enabled

  # TLS 1.2+ load balancer for api / webhooks / connectors / anchor-webhooks.
  # The Anchor host is served through an internet NEG pointing at the tenant
  # project's receiver by its deterministic Cloud Run URL, so no load balancer
  # (and no forwarding-rule minimum) is created in the tenant project.
  public_lb_enabled              = var.public_lb_enabled
  public_lb_cutover              = var.public_lb_cutover
  run_app_ingress_closed         = var.run_app_ingress_closed
  anchor_webhook_receiver_origin = "anchor-webhook-receiver-${module.tenant_liftoffos.project_number}.${var.region}.run.app"
  public_site_hosts              = module.liftoff_website.public_site_hosts

  # The tenant runtime's database moves onto this instance; it reaches it
  # through its own PSC endpoint (tenant-runtime-template/control_db_psc.tf).
  control_plane_psc_consumer_projects = [module.tenant_liftoffos.project_id]
}

module "platform_ci" {
  source = "../../projects/platform-ci"

  org_id                           = var.org_id
  billing_account                  = var.billing_account
  environment                      = var.environment
  region                           = var.region
  platform_control_project_id      = module.platform_control.project_id
  artifact_registry                = module.platform_control.artifact_registry
  github_repos_connected           = var.github_repos_connected
  connector_service_repo_connected = true # liftoff-connector-service connected to prod Cloud Build

  # Phase 3: liftoff-governance-engine connected to Cloud Build in
  # YOUR_CI_PROJECT (us-west1). First build produces the image
  # so `governance_engine_enabled` can flip true in the next apply.
  governance_engine_repo_connected = true

  # Phase 3e: prod runs in "on" — governance-engine RPC is the sole
  # governance path; legacy in-process code is dark. Fail-closed on
  # unreachable. Rollback = flip back to "off" and tenant-runtime
  # resumes in-process governance on next revision (or instantly via
  # `gcloud run services update --update-env-vars GOVERNANCE_SERVICE_ENABLED=off`).
  governance_service_state = "on"

  # workforce-service CI trigger: fires on push to main, deploys to
  # YOUR_CONTROL_PROJECT. Enabled once the GitHub App connects
  # liftoff-workforce-service in the platform-ci-prod Cloud Build console.
  workforce_service_repo_connected = true

  # Phase 0 decomposition: billing and developer-proxy repos connected to
  # Cloud Build in YOUR_CI_PROJECT. Triggers fire on push to main.
  billing_repo_connected         = true
  developer_proxy_repo_connected = true

  # liftoff-harvest-service connected to Cloud Build in
  # YOUR_CI_PROJECT. Trigger fires on push to main.
  harvest_service_repo_connected = true
  tunnel_service_repo_connected  = true # trigger inert until prod cloudbuild.yaml branch + var.tunnel_service_enabled flip

  # developer-proxy deploy step needs the billing service URL as a substitution.
  billing_service_url = module.platform_control.billing_url

  # Forwarded to platform-backend and billing Cloud Build triggers so
  # STRIPE_OU_PRICE_ID is set in all deployed services.
  stripe_ou_price_id = var.stripe_ou_price_id

  # Prod deploys only from a dedicated `release` branch — push to main goes
  # to dev, then a separate merge to release promotes to prod. Prevents any
  # change to main from auto-deploying to live customers.
  deploy_branch_pattern = "^release$"

  # Agent Performance-Understanding Harness (gating closure §1/§4).
  # ENABLED (observability scope): requires the
  # diagnostics-{workforce,insights}-db-url + diagnostics-{anthropic,openai}-api-key
  # secrets, the deepeval-evaluator image, and an eval tenant. canary_agent_id stays "" so the post-deploy
  # user-created canary smoke remains opt-in (same as dev) — i.e. this ships the
  # passive harvest job + evaluator + agent_health alert, NOT the fail-loud
  # deploy-gate/rollback automation (that remains a separate step).
  canary_tenant_id          = var.diagnostics_canary_tenant_id
  canary_agent_id           = var.diagnostics_canary_agent_id
  agent_diagnostics_enabled = true
  # Daily harvest off: run on demand, or set true to schedule it. A scheduled
  # run only scores anything once the judge key is funded, the perimeter allows
  # its secret reads and RLS allows its reads.
  agent_diagnostics_scheduled      = false
  agent_diagnostics_eval_tenant_id = var.diagnostics_canary_tenant_id
  # Durable collab-grade fan-out target. Static string (eval tenant project is
  # deterministic tenant-<id>-<env>) to avoid a platform_ci -> tenant module
  # edge, matching the diagnostics_sa convention below. Tenant job created by
  # the tenant-runtime cloudbuild `create-collab-grade-job` step.
  agent_diagnostics_collab_grade_job = "projects/YOUR_TENANT_PROJECT${var.environment}/locations/${var.region}/jobs/tenant-runtime-collab-grade"
  # evaluate-in-tenant-runtime build promoted to the prod registry via the
  # tenant-runtime release branch. Includes the /harvest endpoint,
  # X-Service-Auth/OIDC auth, cost_usd derivation, and GCS trajectory
  # read-back. Set the tag to the release image prod agent-service runs.
  agent_diagnostics_image_tag      = "611fa85"                              # collab-eval: decoupled grading (judges-only harvest + --collab-grade), durable COLLAB env wiring
  agent_diagnostics_user_agent_id  = "abbb7a1c-f66f-46d8-b65a-e2e52ea77568" # must exist in the prod tenant-runtime DB
  agent_diagnostics_tr_harness_url = "https://agent-service-YOUR_PROJECT_HASH-uw.a.run.app/api/internal/test-harness/run-agent"
  deepeval_evaluator_image         = "${var.region}-docker.pkg.dev/${module.platform_control.project_id}/YOUR_GCP_PROJECT${var.environment}/deepeval-evaluator:v2" # conformance GEval TOOLS_CALLED fix
}

variable "diagnostics_canary_tenant_id" {
  type        = string
  default     = "YOUR_CANARY_TENANT_ID"
  description = "UUID of the operator-owned eval/canary tenant. Drives the passive diagnostics harvest + eval. Replace with your own canary tenant's id."
}

variable "diagnostics_canary_agent_id" {
  type        = string
  default     = ""
  description = "Broad-binding agent on the prod canary tenant for the user-created canary. Empty until the diagnostics stack is activated."
}

# NOTE: platform_observability and platform_security have been consolidated into
# platform_control to reduce project sprawl. Observability (logging, monitoring,
# tracing) and security (KMS, audit) resources are now provisioned within
# the platform-control project.

# -----------------------------------------------------------------------------
# Tenant Projects
# Paying customer tenants will be provisioned in terraform/tenants/{id}/prod/
# with isolated state, prod-only (customers don't get dev/staging counterparts).
# -----------------------------------------------------------------------------

module "tenant_liftoffos" {
  source = "../../projects/tenant-runtime-template"

  providers = {
    google                  = google
    google-beta             = google-beta
    google.platform_control = google.platform_control
    cloudflare              = cloudflare
  }

  org_id                  = var.org_id
  billing_account         = var.billing_account
  environment             = var.environment
  region                  = var.region
  tenant_id               = "liftoffos"
  slack_bot_token         = var.slack_bot_token
  platform_backend_sa     = "platform-backend-${var.environment}@YOUR_GCP_PROJECT${var.environment}.iam.gserviceaccount.com"
  sandbox_sidecar_image   = "us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT/YOUR_ARTIFACT_REPO/sandbox-sidecar:latest"
  framer_rotator_image    = "us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT/YOUR_ARTIFACT_REPO/framer-secret-rotate:ea1f8fd" # the image a NEW job starts from; tenant-runtime's cloudbuild re-pins the job to each build it pushes, and no build pushes a `latest` tag
  tenant_runtime_deployed = true

  # Sub-hourly scheduler jobs fire hourly instead while traffic is low,
  # so agent-service and sandbox-executor can scale to zero between them.
  idle_cadence = true

  # Pass 2 of the two-pass enable documented on the variable itself. Without
  # it agent-scheduler-audit has no cloudscheduler.jobs.list here, so every
  # run logs "tenant project unreachable" and skips the tenant — writing no
  # auditor metrics at all, which leaves Layer C and Layer D comparing
  # against a source that never speaks. Set here so it survives every apply.
  audit_iam_enabled = true

  # Cloudflare zone ID for the anchor-webhook-receiver custom-domain CNAME
  # (see tenant-runtime-template/anchor_webhook_receiver_domain.tf). Same
  # zone as tunnel-service / platform-backend webhooks records.
  cloudflare_zone_id = var.cloudflare_zone_id

  # Phase 1: per-tenant IAM for the Connector Service.
  connector_service_enabled    = module.platform_control.connector_service_enabled
  connector_service_project_id = module.platform_control.project_id
  connector_service_url        = module.platform_control.connector_service_url
  connector_service_sa_email   = module.platform_control.connector_service_sa_email

  # Phase 3: per-tenant IAM for the Governance Engine. Flips on automatically
  # once module.platform_control.governance_engine_enabled is true.
  # The tenant-runtime-template side is named `governance_service_enabled`
  # (plan convention); the platform-control side keeps the `_engine_` name
  # since it gates the live Cloud Run + SQL resources rather than per-tenant
  # IAM wiring.
  governance_service_enabled   = module.platform_control.governance_engine_enabled
  governance_engine_project_id = module.platform_control.governance_engine_project_id
  governance_engine_url        = module.platform_control.governance_engine_url
  governance_engine_sa_email   = module.platform_control.governance_engine_sa_email

  # Phase 4: split services (agent, coordinator, tool-gateway, reflection).
  # Set true once cloudbuild has deployed them and the tenant-runtime
  # monolith is decommissioned, so Terraform owns:
  #   - platform-backend-sa → run.invoker on agent-service (REQUIRED — otherwise
  #     chat-turn fails with "Your client does not have permission" 403)
  #   - intra-tenant invoker bindings between the split services
  split_services_deployed = true

  # Harvest service SA — when set, grants roles/run.invoker so harvest-service
  # can write memories back to this tenant's runtime split services.
  # Static SA email — avoids "count depends on computed value" plan error when
  # google_service_account.harvest_service is created in the same apply.
  harvest_sa = "harvest-service@YOUR_GCP_PROJECT${var.environment}.iam.gserviceaccount.com"

  # Eval tenant: grant the agent-diagnostics job SA run.invoker on agent-service
  # so the passive eval job can call the in-tenant /harvest endpoint. Static SA
  # email (matches platform_ci agent_diagnostics SA) — avoids a count-on-computed
  # plan error in the template's diagnostics_agent_invoker.
  diagnostics_sa = "agent-diagnostics-${var.environment}@YOUR_GCP_PROJECT${var.environment}.iam.gserviceaccount.com"

  # Eval tenant runtime UUID — lets the runtime SA read back its OWN trajectory
  # objects (keyed by this UUID) so the in-tenant harvest uses the lossless GCS
  # trajectory instead of the raw-table fallback. Scoped by IAM condition.
  trajectory_reader_tenant_uuid = var.diagnostics_canary_tenant_id

  # Endpoint onto control-plane-pg, where the runtime's database lives.
  control_pg_psc_enabled            = true
  control_pg_psc_service_attachment = module.platform_control.control_plane_psc_service_attachment
}

# cdn.example.com predates Terraform's DNS management; adopt it.
import {
  to = module.liftoff_website.cloudflare_record.cdn
  id = "666f0deb7aa852085ec5640ddcd2a57c/580dd3e8c5646d8015c915f18e328ea7"
}

module "liftoff_website" {
  source = "../../projects/YOUR_WEB_PROJECT"

  project_id              = "YOUR_WEB_PROJECT"
  region                  = var.region
  ci_cloud_build_sa_email = module.platform_ci.cloud_build_sa

  # The site's backends and DNS (public_lb.tf); the control load balancer serves it.
  cloudflare_zone_id = var.cloudflare_zone_id

  # The site's hosts are served by the control load balancer
  # (platform-control/public_lb.tf, `public_site_hosts`); DNS points there.
  site_lb = {
    ip       = module.platform_control.public_lb_ip
    dns_name = module.platform_control.public_lb_dns_name
  }

  # The PB SA needs to call Identity Toolkit against this project's
  # Firebase Auth — verifyIdToken(token, checkRevoked=true) needs
  # firebaseauth.users.get. Same project hosts both env's Firebase Auth
  # tenants (single YOUR_WEB_PROJECT project, no env-split for the auth side).
  firebase_auth_viewer_sa_emails = [
    "YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
  ]

  # The PB SA also needs to read Remote Config (`allowed_domains`) from this
  # project. Same single-project setup as Firebase Auth above.
  firebase_remote_config_viewer_sa_emails = [
    "YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
  ]

  # The PB SA also needs to SEND FCM messages for this project, because browser
  # push tokens are minted against this project's sender ID. Same single-project
  # setup as Firebase Auth and Remote Config above.
  firebase_cloud_messaging_sender_sa_emails = [
    "YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com",
  ]
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "platform_control_project" {
  value = module.platform_control.project_id
}

output "platform_ci_project" {
  value = module.platform_ci.project_id
}

output "tenant_liftoffos_project" {
  value       = module.tenant_liftoffos.project_id
  description = "LiftoffOS tenant project: YOUR_TENANT_PROJECT"
}

output "workload_identity_provider" {
  value       = module.platform_ci.workload_identity_provider
  description = "Workload Identity Provider for GitHub Actions"
}

# -----------------------------------------------------------------------------
# Terraform 1.7 `import` blocks (one-time adoption of out-of-band resources)
# -----------------------------------------------------------------------------

# Prod-only: adopt the platform-backend `control-plane-events-prod-sub`
# subscription that was created out-of-band before the unified workspace audit
# log shipped (see platform-control/main.tf →
# google_pubsub_subscription.control_plane_events_platform_backend).
#
# Without this `import` block, the first prod apply after this PR merges would
# attempt to CREATE a subscription that already exists and fail with
# ALREADY_EXISTS. With it, the resource is adopted and the next plan will
# show three property changes — all of them upgrades:
#
#   ~ dead_letter_policy = (new)         → forward poison messages to dead-letter-prod
#                                          instead of dropping them
#   ~ retry_policy       = (new)         → explicit 10s..600s backoff (currently GCP defaults)
#   ~ expiration_policy  = 31d  → never  → prevents accidental sub deletion if
#                                          platform-backend boots get quiet
#
# Review the plan before applying. Once applied this block can be removed
# (Terraform will keep the resource in state).
#
# Dev's mirror lives in environments/dev/main.tf and adopts the gcloud-
# created subscription with the same settings (so dev's apply diff is empty).
import {
  to = module.platform_control.google_pubsub_subscription.control_plane_events_platform_backend
  id = "projects/YOUR_CONTROL_PROJECT/subscriptions/control-plane-events-prod-sub"
}

# Adopt a hand-created typesafe-api-key secret into state on first apply, so platform-control's new
# google_secret_manager_secret.typesafe_api_key resource does not collide with
# the existing object. One-time no-op once imported; safe to leave in place.
import {
  to = module.platform_control.google_secret_manager_secret.typesafe_api_key
  id = "projects/YOUR_CONTROL_PROJECT/secrets/typesafe-api-key"
}
