# Restore Drill Module Variables
# Per Section 22 Phase 5: Restore drill automation

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-west1"
}

variable "environment" {
  description = "Environment (dev, staging, prod)"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod"
  }
}

variable "source_instance_name" {
  description = "Cloud SQL instance name to test restores against"
  type        = string
}

variable "notification_channels" {
  description = "Cloud Monitoring notification channel IDs for drill alerts"
  type        = list(string)
  default     = []
}

variable "drill_config" {
  description = "Configuration for restore drills"
  type = object({
    quarterly_enabled = bool
    monthly_enabled   = bool
    pitr_enabled      = bool
    backup_enabled    = bool
    retention_days    = number
  })
  default = {
    quarterly_enabled = true
    monthly_enabled   = true
    pitr_enabled      = true
    backup_enabled    = false
    retention_days    = 365
  }
}
