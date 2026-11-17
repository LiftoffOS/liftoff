# Production Environment Configuration
# Per Section 19: Disaster Recovery Setup

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }

  backend "gcs" {
    bucket = "YOUR_CI_PROJECT-tfstate"
    prefix = "terraform/state"
  }
}

provider "google" {
  region = var.primary_region
}

provider "google-beta" {
  region = var.primary_region
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

variable "primary_region" {
  type        = string
  default     = "us-central1"
  description = "Primary region for deployment"
}

variable "dr_region" {
  type        = string
  default     = "us-east1"
  description = "Disaster recovery region"
}

variable "billing_enabled" {
  type        = bool
  default     = true
  description = "Whether billing is enabled for all projects"
}

locals {
  environment = "prod"
}

# -----------------------------------------------------------------------------
# Platform Projects
# -----------------------------------------------------------------------------

module "platform_control" {
  source = "../../terraform/projects/platform-control"

  org_id          = var.org_id
  billing_account = var.billing_account
  environment     = local.environment
  region          = var.primary_region
}

module "platform_ci" {
  source = "../../terraform/projects/platform-ci"

  org_id                      = var.org_id
  billing_account             = var.billing_account
  environment                 = local.environment
  region                      = var.primary_region
  platform_control_project_id = module.platform_control.project_id
  artifact_registry           = module.platform_control.artifact_registry_url
  github_repos_connected      = true
}

module "platform_observability" {
  source = "../../terraform/projects/platform-observability"

  org_id                      = var.org_id
  billing_account             = var.billing_account
  environment                 = local.environment
  region                      = var.primary_region
  platform_control_project_id = module.platform_control.project_id
}

module "platform_security" {
  source = "../../terraform/projects/platform-security"

  org_id          = var.org_id
  billing_account = var.billing_account
  environment     = local.environment
  region          = var.primary_region
  billing_enabled = var.billing_enabled

  platform_control_project_number       = module.platform_control.project_number
  platform_ci_project_number            = module.platform_ci.project_number
  platform_observability_project_number = module.platform_observability.project_number
}

# -----------------------------------------------------------------------------
# Disaster Recovery - Cross-Region Resources
# Per Section 19: Multi-region for disaster recovery
# -----------------------------------------------------------------------------

# DR Artifact Registry (replica in DR region)
resource "google_artifact_registry_repository" "dr_repository" {
  project       = module.platform_control.project_id
  location      = var.dr_region
  repository_id = "YOUR_GCP_PROJECT${local.environment}"
  format        = "DOCKER"
  description   = "Disaster recovery container registry"

  labels = {
    environment = local.environment
    purpose     = "disaster-recovery"
  }
}

# Cross-region replication policy for container images
resource "google_artifact_registry_repository" "primary_with_replication" {
  project       = module.platform_control.project_id
  location      = var.primary_region
  repository_id = "YOUR_GCP_PROJECT${local.environment}"
  format        = "DOCKER"
  description   = "Primary container registry with DR replication"

  remote_repository_config {
    description = "DR mirror"
    docker_repository {
      public_repository = "DOCKER_HUB"
    }
  }

  labels = {
    environment = local.environment
    replicated  = "true"
  }
}

# Cloud Storage bucket for backups (multi-region)
resource "google_storage_bucket" "backup_bucket" {
  project  = module.platform_control.project_id
  name     = "backups-${local.environment}-${var.org_id}"
  location = "US" # Multi-region

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    environment = local.environment
    purpose     = "backups"
  }
}

# Cloud SQL backup configuration is in the cloud-sql module
# This just documents the DR strategy

# Global Load Balancer for failover (placeholder for future)
# Would use google_compute_global_address and
# google_compute_backend_service with multi-region NEGs

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "platform_control_project" {
  value = module.platform_control.project_id
}

output "platform_ci_project" {
  value = module.platform_ci.project_id
}

output "platform_security_project" {
  value = module.platform_security.project_id
}

output "dr_region" {
  value = var.dr_region
}

output "backup_bucket" {
  value = google_storage_bucket.backup_bucket.name
}

output "dr_artifact_registry" {
  value = google_artifact_registry_repository.dr_repository.name
}
