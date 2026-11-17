// WS-7.1 — declarative cross-project Secret Manager access.
//
// Today the tenant-runtime SA needs roles/secretmanager.secretAccessor on
// every Anthropic API-key secret in the control project, but the binding is
// invisible Terraform-side and chronically missing. This module makes the
// binding declarative + plan-visible.

variable "runtime_service_account_email" {
  description = "Service account in the tenant-runtime project that needs to read these secrets"
  type        = string
}

variable "control_project_id" {
  description = "GCP project holding the secrets (e.g., YOUR_CONTROL_PROJECT)"
  type        = string
}

variable "secret_names" {
  description = "List of secret names in the control project"
  type        = list(string)
}

// Granting IAM directly on the secret_id string avoids a chicken-and-egg
// against secrets created in the same root plan: a `data` lookup would
// resolve at plan time before the resource exists. The provider validates
// existence at apply time anyway.
resource "google_secret_manager_secret_iam_member" "runtime_access" {
  for_each  = toset(var.secret_names)
  project   = var.control_project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.runtime_service_account_email}"
}
