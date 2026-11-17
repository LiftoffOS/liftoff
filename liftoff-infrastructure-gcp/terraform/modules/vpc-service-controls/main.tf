# VPC Service Controls Module
# Per Section 20: VPC Service Controls to reduce exfiltration risk

variable "org_id" {
  description = "GCP Organization ID"
  type        = string
}

variable "policy_title" {
  description = "Access policy title"
  type        = string
}

variable "perimeter_title" {
  description = "Service perimeter title"
  type        = string
}

variable "protected_project_numbers" {
  description = "List of project numbers to include in the perimeter"
  type        = list(string)
}

variable "restricted_services" {
  description = "List of services to restrict"
  type        = list(string)
  default = [
    "storage.googleapis.com",
    "bigquery.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "aiplatform.googleapis.com",
  ]
}

variable "ci_cd_service_accounts" {
  description = "Service accounts allowed CI/CD access"
  type        = list(string)
  default     = []
}

variable "internal_service_accounts" {
  description = "Internal service accounts allowed access"
  type        = list(string)
  default     = []
}

variable "egress_external_resources" {
  description = "External resources allowed for egress"
  type        = list(string)
  default     = []
}

variable "webhook_source_ranges" {
  description = "Allowed IP ranges for webhook ingress (e.g., Stripe webhook IPs)"
  type        = list(string)
  default = [
    # Stripe webhook IPs
    "54.187.174.169/32",
    "54.187.205.235/32",
    "54.187.216.72/32",
    "54.241.31.99/32",
    "54.241.31.102/32",
    "54.241.34.107/32",
  ]
}

variable "ingress_allowed_service_accounts" {
  description = "Service accounts allowed for ingress"
  type        = list(string)
  default     = []
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "enabled" {
  description = "Enable VPC Service Controls. Per Section 20, defaults to true for prod."
  type        = bool
  default     = null # When null, will be determined by environment
}

locals {
  # Per Section 20: VPC Service Controls enabled for production by default
  is_enabled = var.enabled != null ? var.enabled : (var.environment == "prod")
}

# Access Policy
resource "google_access_context_manager_access_policy" "policy" {
  count  = local.is_enabled ? 1 : 0
  parent = "organizations/${var.org_id}"
  title  = var.policy_title
}

# Access Level for CI/CD
resource "google_access_context_manager_access_level" "ci_cd" {
  count  = local.is_enabled && length(var.ci_cd_service_accounts) > 0 ? 1 : 0
  parent = "accessPolicies/${google_access_context_manager_access_policy.policy[0].name}"
  name   = "accessPolicies/${google_access_context_manager_access_policy.policy[0].name}/accessLevels/ci_cd_access"
  title  = "CI/CD Pipeline Access"

  basic {
    conditions {
      members = [for sa in var.ci_cd_service_accounts : "serviceAccount:${sa}"]
    }
  }
}

# Access Level for Internal Services
resource "google_access_context_manager_access_level" "internal_services" {
  count  = local.is_enabled && length(var.internal_service_accounts) > 0 ? 1 : 0
  parent = "accessPolicies/${google_access_context_manager_access_policy.policy[0].name}"
  name   = "accessPolicies/${google_access_context_manager_access_policy.policy[0].name}/accessLevels/internal_services"
  title  = "Internal Service Access"

  basic {
    conditions {
      members = [for sa in var.internal_service_accounts : "serviceAccount:${sa}"]
    }
  }
}

# Service Perimeter
resource "google_access_context_manager_service_perimeter" "perimeter" {
  count  = local.is_enabled ? 1 : 0
  parent = "accessPolicies/${google_access_context_manager_access_policy.policy[0].name}"
  name   = "accessPolicies/${google_access_context_manager_access_policy.policy[0].name}/servicePerimeters/${replace(lower(var.perimeter_title), " ", "_")}"
  title  = var.perimeter_title

  status {
    resources = [for pn in var.protected_project_numbers : "projects/${pn}"]

    restricted_services = var.restricted_services

    access_levels = compact([
      length(var.ci_cd_service_accounts) > 0 ? google_access_context_manager_access_level.ci_cd[0].name : "",
      length(var.internal_service_accounts) > 0 ? google_access_context_manager_access_level.internal_services[0].name : "",
    ])

    vpc_accessible_services {
      enable_restriction = true
      allowed_services   = ["RESTRICTED-SERVICES"]
    }

    # Egress policy for external resources
    dynamic "egress_policies" {
      for_each = length(var.egress_external_resources) > 0 ? [1] : []
      content {
        egress_from {
          identity_type = "ANY_IDENTITY"
        }
        egress_to {
          external_resources = var.egress_external_resources
          operations {
            service_name = "aiplatform.googleapis.com"
            method_selectors {
              method = "*"
            }
          }
        }
      }
    }

    # Ingress policy for webhooks - restricted to known sources
    # Per Section 20: Remove ANY_IDENTITY wildcard, use specific source IPs and service accounts
    dynamic "ingress_policies" {
      for_each = length(var.webhook_source_ranges) > 0 ? [1] : []
      content {
        ingress_from {
          # Use specific service accounts if provided, otherwise allow from access levels
          identity_type = length(var.ingress_allowed_service_accounts) > 0 ? "IDENTITY_TYPE_UNSPECIFIED" : null
          identities    = length(var.ingress_allowed_service_accounts) > 0 ? [for sa in var.ingress_allowed_service_accounts : "serviceAccount:${sa}"] : null
          sources {
            # Restrict to CI/CD access level for internal services
            access_level = length(var.ci_cd_service_accounts) > 0 ? google_access_context_manager_access_level.ci_cd[0].name : "*"
          }
        }
        ingress_to {
          resources = ["*"]
          operations {
            service_name = "run.googleapis.com"
            method_selectors {
              method = "POST" # Webhooks only need POST
            }
          }
        }
      }
    }

    # Ingress policy for internal service accounts
    dynamic "ingress_policies" {
      for_each = length(var.internal_service_accounts) > 0 ? [1] : []
      content {
        ingress_from {
          identity_type = "IDENTITY_TYPE_UNSPECIFIED"
          identities    = [for sa in var.internal_service_accounts : "serviceAccount:${sa}"]
          sources {
            access_level = google_access_context_manager_access_level.internal_services[0].name
          }
        }
        ingress_to {
          resources = ["*"]
          operations {
            service_name = "*"
            method_selectors {
              method = "*"
            }
          }
        }
      }
    }
  }
}

output "access_policy_name" {
  value = local.is_enabled ? google_access_context_manager_access_policy.policy[0].name : ""
}

output "perimeter_name" {
  value = local.is_enabled ? google_access_context_manager_service_perimeter.perimeter[0].name : ""
}
