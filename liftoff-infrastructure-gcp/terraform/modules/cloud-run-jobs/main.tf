# Cloud Run Jobs Module
# Per Section 2: Cloud Run jobs for replay, sweeps, and maintenance jobs
# Per Section 17: Restore drill jobs

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
}

variable "job_name" {
  description = "Name of the Cloud Run Job"
  type        = string
}

variable "image" {
  description = "Container image for the job"
  type        = string
}

variable "service_account_email" {
  description = "Service account email for job execution"
  type        = string
}

variable "cpu" {
  description = "CPU allocation"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory allocation"
  type        = string
  default     = "512Mi"
}

variable "timeout" {
  description = "Job timeout in seconds"
  type        = number
  default     = 3600 # 1 hour default for jobs
}

variable "max_retries" {
  description = "Maximum retry count for failed jobs"
  type        = number
  default     = 3
}

variable "parallelism" {
  description = "Number of parallel tasks"
  type        = number
  default     = 1
}

variable "task_count" {
  description = "Total number of tasks to run"
  type        = number
  default     = 1
}

variable "env_vars" {
  description = "Environment variables for the job"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secrets from Secret Manager"
  type = list(object({
    name        = string
    secret_name = string
    version     = string
  }))
  default = []
}

variable "cloudsql_connections" {
  description = "Cloud SQL instance connections"
  type        = list(string)
  default     = []
}

variable "labels" {
  description = "Additional labels for the job"
  type        = map(string)
  default     = {}
}

variable "invokers" {
  description = "Members who can invoke this job"
  type        = list(string)
  default     = []
}

locals {
  labels = merge({
    environment = var.environment
    managed-by  = "terraform"
    job         = var.job_name
  }, var.labels)
}

# Cloud Run Job
resource "google_cloud_run_v2_job" "job" {
  project  = var.project_id
  name     = var.job_name
  location = var.region

  labels = local.labels

  template {
    labels = local.labels

    parallelism = var.parallelism
    task_count  = var.task_count

    template {
      service_account = var.service_account_email
      timeout         = "${var.timeout}s"
      max_retries     = var.max_retries

      containers {
        image = var.image

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }

        # Static environment variables
        dynamic "env" {
          for_each = var.env_vars
          content {
            name  = env.key
            value = env.value
          }
        }

        # Secret environment variables from Secret Manager
        dynamic "env" {
          for_each = var.secrets
          content {
            name = env.value.name
            value_source {
              secret_key_ref {
                secret  = env.value.secret_name
                version = env.value.version
              }
            }
          }
        }

        # Standard environment variables
        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }

        env {
          name  = "GCP_PROJECT"
          value = var.project_id
        }

        env {
          name  = "GCP_REGION"
          value = var.region
        }
      }

      # Cloud SQL connections
      dynamic "volumes" {
        for_each = length(var.cloudsql_connections) > 0 ? [1] : []
        content {
          name = "cloudsql"
          cloud_sql_instance {
            instances = var.cloudsql_connections
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      # Allow CI/CD to update the image
      template[0].template[0].containers[0].image,
    ]
  }
}

# IAM binding for job invokers
resource "google_cloud_run_v2_job_iam_member" "invokers" {
  for_each = toset(var.invokers)

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.job.name
  role     = "roles/run.invoker"
  member   = each.value
}

# Outputs
output "job_name" {
  description = "Name of the Cloud Run Job"
  value       = google_cloud_run_v2_job.job.name
}

output "job_id" {
  description = "Full ID of the Cloud Run Job"
  value       = google_cloud_run_v2_job.job.id
}

output "job_uri" {
  description = "URI for triggering the job"
  value       = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${var.job_name}:run"
}
