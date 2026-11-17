// WS-7.1 — declarative cross-project Secret Manager access for the
// tenant-runtime SA. Without this, the SA reads anthropic-api-key-*-prod
// from YOUR_CONTROL_PROJECT by no granted IAM, and the runtime
// silently falls back through `required: false` masks.

module "tenant_runtime_secret_access" {
  source = "../../modules/secret-cross-project-access"

  runtime_service_account_email = module.iam.tenant_runtime_sa
  control_project_id            = "YOUR_GCP_PROJECT${var.environment}"

  secret_names = [
    "anthropic-api-key",
    "anthropic-api-key-agent-execution-${var.environment}",
    "anthropic-api-key-background-services-${var.environment}",
    "anthropic-api-key-platform-analytics-${var.environment}",
    "anthropic-api-key-reflective-services-${var.environment}",
    "openai-api-key-agent-execution-${var.environment}",
    "openai-api-key-background-services-${var.environment}",
    "openai-api-key-platform-analytics-${var.environment}",
    "openai-api-key-reflective-services-${var.environment}",
    "connector-service-token",
    "governance-engine-token",
  ]
}
