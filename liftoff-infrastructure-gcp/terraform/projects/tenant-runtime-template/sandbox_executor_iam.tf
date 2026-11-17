// IAM grants for the sandbox-executor service account.
//
// The orchestrator runs as `sandbox-executor@…` (created in main.tf alongside
// the static service resource) and needs:
//
//   - run.admin           — POST per-sandbox Cloud Run services + setIamPolicy
//                           on the created services to grant invoker to itself.
//   - iam.serviceAccountUser on its own SA — required by Cloud Run's actAs
//                           check when the orchestrator creates per-sandbox
//                           services that run as `template.serviceAccount = self`.
//   - cloudkms.cryptoKeyEncrypterDecrypter — already granted in sandbox_aio.tf
//                           for the per-tenant sandbox-jwt-secret crypto key.
//                           Not re-asserted here.
//   - cloudsql.client     — DB pool against the tenant runtime instance.
//   - pubsub.publisher    — UsageLedger / spend-subscriber publish OU drain
//                           events to control-plane-events-${env}.
//   - secretmanager.secretAccessor — DB password, runtime service token.
//   - logging.logWriter   — standard Cloud Run log writes.
//   - monitoring.metricWriter — standard Cloud Run metric writes.
//
// This SA is the privilege concentration point for sandbox operations. The
// LLM-driven tool-gateway service does NOT carry Cloud Run admin or KMS
// encrypter — sandbox provisioning happens via OIDC-gated POST /v2/execute
// to sandbox-executor, not in-process on tool-gateway.

resource "google_project_iam_member" "sandbox_executor_run_admin" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

# actAs on its own SA — the create call sets template.serviceAccount = self,
# which Cloud Run validates against the caller's `iam.serviceAccountUser`
# permission on the target SA. Without this, per-sandbox creates fail with
# `Permission iam.serviceAccounts.actAs denied`.
resource "google_service_account_iam_member" "sandbox_executor_actas_self" {
  service_account_id = google_service_account.sandbox_executor.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

resource "google_project_iam_member" "sandbox_executor_cloudsql_client" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

resource "google_project_iam_member" "sandbox_executor_pubsub_publisher" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

resource "google_project_iam_member" "sandbox_executor_secrets" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

resource "google_project_iam_member" "sandbox_executor_log_writer" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

resource "google_project_iam_member" "sandbox_executor_metric_writer" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

# So tool-gateway-service (running as tenant-${id}-runtime SA) and
# agent-service can call sandbox-executor over OIDC. Cloud Run defaults to no
# invokers, so without this every tool-gateway → sandbox-executor request 401s
# at the Cloud Run frontend. Gated on the same count as the service resource —
# off → no service to grant on.
resource "google_cloud_run_v2_service_iam_member" "sandbox_executor_invokable_by_runtime" {
  count = var.split_services_deployed ? 1 : 0

  project  = google_project.tenant_runtime.project_id
  location = google_cloud_run_v2_service.sandbox_executor[0].location
  name     = google_cloud_run_v2_service.sandbox_executor[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${module.iam.tenant_runtime_sa}"
}

# Sandbox-executor calls back to agent-service for SSE event relay (the
# /internal/sandbox/events proxy mounted on sandbox-executor itself fans
# events out via agent-service's broadcast pipeline) and to tool-gateway-service
# for the /internal/sandbox/mcp/dispatch governance proxy. Both peers are
# INGRESS_TRAFFIC_INTERNAL_ONLY with --no-allow-unauthenticated, so
# sandbox-executor's SA needs run.invoker on each. Mirrors the cross-service
# grants in the split_service_intra_invoker loop (main.tf:1010) which only
# covers the tenant_runtime_sa caller, not sandbox-executor.
resource "google_cloud_run_v2_service_iam_member" "sandbox_executor_invokes_agent_service" {
  count = var.split_services_deployed ? 1 : 0

  project  = google_project.tenant_runtime.project_id
  location = google_cloud_run_v2_service.agent_service[0].location
  name     = google_cloud_run_v2_service.agent_service[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

resource "google_cloud_run_v2_service_iam_member" "sandbox_executor_invokes_tool_gateway" {
  count = var.split_services_deployed ? 1 : 0

  project  = google_project.tenant_runtime.project_id
  location = google_cloud_run_v2_service.tool_gateway_service[0].location
  name     = google_cloud_run_v2_service.tool_gateway_service[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.sandbox_executor.email}"
}

# NOTE: sandbox-executor is deployed --allow-unauthenticated (--ingress internal)
# by cloudbuild — it's the sandbox-facing bridge, reached by the in-sandbox
# sidecar bearing only its per-sandbox HS256 JWT (which Cloud Run's frontend
# can't verify as a Google token). Network is guarded by internal ingress + the
# app-level oidcGate / requireSandboxJwt on every route. So the sidecar->executor
# hop needs NO run.invoker grant here; the executor->tool-gateway / ->agent-service
# proxy hops use the two sandbox_executor_invokes_* grants above.
