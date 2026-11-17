variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "notification_channels" {
  description = "Cloud Monitoring notification channel IDs"
  type        = list(string)
  default     = []
}
