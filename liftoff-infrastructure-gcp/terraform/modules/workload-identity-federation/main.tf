# Workload Identity Federation Module
# Per Section 20: Workload Identity Federation for CI/CD

variable "project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "pool_id" {
  description = "Workload Identity Pool ID"
  type        = string
}

variable "pool_display_name" {
  description = "Display name for the pool"
  type        = string
}

variable "pool_description" {
  description = "Description for the pool"
  type        = string
  default     = "Workload Identity Pool for external CI/CD"
}

# Provider configuration for different CI/CD platforms
variable "github_provider" {
  description = "GitHub Actions provider configuration"
  type = object({
    enabled              = bool
    provider_id          = string
    allowed_repositories = list(string)
  })
  default = {
    enabled              = false
    provider_id          = "github-provider"
    allowed_repositories = []
  }
}

variable "gitlab_provider" {
  description = "GitLab CI provider configuration"
  type = object({
    enabled        = bool
    provider_id    = string
    gitlab_url     = string
    allowed_groups = list(string)
  })
  default = {
    enabled        = false
    provider_id    = "gitlab-provider"
    gitlab_url     = "https://gitlab.com"
    allowed_groups = []
  }
}

variable "service_account_bindings" {
  description = "Map of service account emails to allowed identity patterns"
  type = map(object({
    service_account_email = string
    attribute_condition   = string
  }))
  default = {}
}

# Workload Identity Pool
resource "google_iam_workload_identity_pool" "pool" {
  project                   = var.project_id
  workload_identity_pool_id = var.pool_id
  display_name              = var.pool_display_name
  description               = var.pool_description
}

# GitHub Actions Provider
resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = var.github_provider.enabled ? 1 : 0
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.pool.workload_identity_pool_id
  workload_identity_pool_provider_id = var.github_provider.provider_id
  display_name                       = "GitHub Actions"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.actor"            = "assertion.actor"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
    "attribute.ref"              = "assertion.ref"
    "attribute.ref_type"         = "assertion.ref_type"
  }

  # Restrict to specific repositories
  attribute_condition = length(var.github_provider.allowed_repositories) > 0 ? join(" || ", [
    for repo in var.github_provider.allowed_repositories :
    "assertion.repository == \"${repo}\""
  ]) : null

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# GitLab CI Provider
resource "google_iam_workload_identity_pool_provider" "gitlab" {
  count                              = var.gitlab_provider.enabled ? 1 : 0
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.pool.workload_identity_pool_id
  workload_identity_pool_provider_id = var.gitlab_provider.provider_id
  display_name                       = "GitLab CI"

  attribute_mapping = {
    "google.subject"           = "assertion.sub"
    "attribute.project_path"   = "assertion.project_path"
    "attribute.namespace_path" = "assertion.namespace_path"
    "attribute.ref"            = "assertion.ref"
    "attribute.ref_type"       = "assertion.ref_type"
  }

  # Restrict to specific groups
  attribute_condition = length(var.gitlab_provider.allowed_groups) > 0 ? join(" || ", [
    for group in var.gitlab_provider.allowed_groups :
    "assertion.namespace_path.startsWith(\"${group}\")"
  ]) : null

  oidc {
    issuer_uri = var.gitlab_provider.gitlab_url
  }
}

# Service Account bindings for workload identity
resource "google_service_account_iam_member" "workload_identity" {
  for_each           = var.service_account_bindings
  service_account_id = "projects/${var.project_id}/serviceAccounts/${each.value.service_account_email}"
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.pool.name}/${each.value.attribute_condition}"
}

output "pool_name" {
  value = google_iam_workload_identity_pool.pool.name
}

output "github_provider_name" {
  value = var.github_provider.enabled ? google_iam_workload_identity_pool_provider.github[0].name : ""
}

output "gitlab_provider_name" {
  value = var.gitlab_provider.enabled ? google_iam_workload_identity_pool_provider.gitlab[0].name : ""
}

# Helper output for configuring GitHub Actions
output "github_actions_config" {
  value = var.github_provider.enabled ? {
    workload_identity_provider = google_iam_workload_identity_pool_provider.github[0].name
    # Format for google-github-actions/auth
    provider_url = "projects/${var.project_id}/locations/global/workloadIdentityPools/${var.pool_id}/providers/${var.github_provider.provider_id}"
  } : null
}
