variable "platform_control_project" {
  description = "Platform control GCP project ID for this environment"
  type        = string
}

variable "tenant_runtime_project" {
  description = "Tenant runtime GCP project ID for this environment"
  type        = string
}

variable "platform_backend_url" {
  description = "Public URL of the platform backend"
  type        = string
}

variable "tenant_runtime_url" {
  description = "Public URL of the tenant runtime"
  type        = string
}

variable "alert_notification_channel" {
  description = "Notification channel ID for alert policies"
  type        = string
}

variable "platform_callback_token" {
  description = "Service-to-service callback bearer token"
  type        = string
  sensitive   = true
}

variable "platform_control_scheduler_sa" {
  description = "Service account email used by Cloud Scheduler jobs that invoke platform-backend. Used as the OIDC token identity (the SA must have roles/run.invoker on platform-backend's Cloud Run service)."
  type        = string
}

variable "tenant_runtime_scheduler_sa" {
  description = "Service account email used by Cloud Scheduler jobs that invoke the tenant-runtime Cloud Run service. Used as the OIDC token identity (the SA must have roles/run.invoker on the tenant-runtime service)."
  type        = string
}
