# Cloud Tasks Module
# Per Section 6: Durable execution with retries and bounded execution

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "tenant_id" {
  description = "Tenant ID for tenant-specific queues"
  type        = string
  default     = ""
}

variable "cloud_run_service_url" {
  description = "Cloud Run service URL for task handlers"
  type        = string
  default     = ""
}

variable "service_account_email" {
  description = "Service account email for Cloud Tasks"
  type        = string
  default     = ""
}

# Per Section 2 and Section 6: Queue configurations per implementation plan
# Required queues: agent-tasks, workflow-tasks, action-tasks, reflection-tasks,
#                  connector-tasks, maintenance-tasks
locals {
  # Queue configurations with specific rate limits and retry policies
  # Names aligned with Section 2 specification
  queue_configs = {
    # Per Section 2: agent-tasks - High-priority agent execution queue
    "agent-tasks" = {
      max_concurrent_dispatches = 100
      max_dispatches_per_second = 150
      max_attempts              = 5
      min_backoff               = "1s"
      max_backoff               = "300s"
      max_doublings             = 4
      max_retry_duration        = "3600s" # 1 hour
      handler_path              = "/api/tasks/agent"
      priority                  = "high"
    }

    # Chat continuations — a chat turn of an AI team that a bound closed with
    # work still to do goes on as a run on the same conversation, delivered to
    # /api/tasks/resume-execution like every other resume.
    #
    # Its own queue because the retry policy differs from agent-tasks' five
    # attempts: what makes a continuation retry is the conversation's turn lock
    # being BUSY (the turn that queued it still finishing, or a person
    # talking), and that has to be re-delivered with backoff until the
    # conversation is free — twenty attempts at 5s to 60s, about fifteen
    # minutes, the same policy the platform assistants' continuations get in
    # the control project. The handler reads X-CloudTasks-TaskRetryCount and
    # marks the row failed itself on the last delivery, so no row is left
    # pending once this queue has given up.
    "chat-continuations" = {
      max_concurrent_dispatches = 20
      max_dispatches_per_second = 20
      max_attempts              = 20
      min_backoff               = "5s"
      max_backoff               = "60s"
      max_doublings             = 4
      max_retry_duration        = "1800s" # 30 minutes; the attempt count binds first
      handler_path              = "/api/tasks/resume-execution"
      priority                  = "high"
    }

    # DAG child executor — dedicated queue so fan-out can't starve normal agent traffic.
    "child-tasks" = {
      max_concurrent_dispatches = 64
      max_dispatches_per_second = 64
      max_attempts              = 5
      min_backoff               = "1s"
      max_backoff               = "300s"
      max_doublings             = 4
      max_retry_duration        = "3600s"
      handler_path              = "/api/tasks/child-execution"
      priority                  = "high"
    }

    # Per Section 2: workflow-tasks - High-priority workflow orchestration
    "workflow-tasks" = {
      max_concurrent_dispatches = 50
      max_dispatches_per_second = 100
      max_attempts              = 10
      min_backoff               = "1s"
      max_backoff               = "600s"
      max_doublings             = 5
      max_retry_duration        = "7200s" # 2 hours
      handler_path              = "/api/tasks/workflow"
      priority                  = "high"
    }

    # Per Section 2: action-tasks - Medium-priority external actions
    "action-tasks" = {
      max_concurrent_dispatches = 50
      max_dispatches_per_second = 50
      max_attempts              = 5
      min_backoff               = "2s"
      max_backoff               = "300s"
      max_doublings             = 4
      max_retry_duration        = "1800s" # 30 minutes
      handler_path              = "/api/tasks/action"
      priority                  = "medium"
    }

    # Per Section 2: reflection-tasks - Low-priority reflection processing
    "reflection-tasks" = {
      max_concurrent_dispatches = 15
      max_dispatches_per_second = 10
      max_attempts              = 3
      min_backoff               = "30s"
      max_backoff               = "1800s" # 30 minutes
      max_doublings             = 3
      max_retry_duration        = "10800s" # 3 hours
      handler_path              = "/api/tasks/reflection"
      priority                  = "low"
    }

    # Per Section 2: connector-tasks - Medium-priority connector operations
    "connector-tasks" = {
      max_concurrent_dispatches = 30
      max_dispatches_per_second = 30
      max_attempts              = 5
      min_backoff               = "5s"
      max_backoff               = "600s"
      max_doublings             = 3
      max_retry_duration        = "3600s"
      handler_path              = "/api/tasks/connector"
      priority                  = "medium"
    }

    # Per Section 2: maintenance-tasks - Low-priority maintenance operations
    "maintenance-tasks" = {
      max_concurrent_dispatches = 5
      max_dispatches_per_second = 2
      max_attempts              = 3
      min_backoff               = "60s"
      max_backoff               = "3600s"
      max_doublings             = 2
      max_retry_duration        = "14400s" # 4 hours
      handler_path              = "/api/tasks/maintenance"
      priority                  = "low"
    }

    # Additional queues for specific functionality (not in Section 2 but needed)

    # Per implementation plan Phase 1.3: Agent execution queue
    # Used by Cloud Tasks handler for scheduled/async agent execution
    "agent-execution" = {
      max_concurrent_dispatches = 100
      max_dispatches_per_second = 100
      max_attempts              = 5
      min_backoff               = "1s"
      max_backoff               = "300s"
      max_doublings             = 4
      max_retry_duration        = "3600s" # 1 hour
      handler_path              = "/api/tasks/execute"
      priority                  = "high"
    }

    # Data export jobs
    "export-tasks" = {
      max_concurrent_dispatches = 5
      max_dispatches_per_second = 2
      max_attempts              = 3
      min_backoff               = "60s"
      max_backoff               = "1800s"
      max_doublings             = 2
      max_retry_duration        = "7200s"
      handler_path              = "/api/tasks/export"
      priority                  = "low"
    }

    # Billing reconciliation
    "billing-tasks" = {
      max_concurrent_dispatches = 3
      max_dispatches_per_second = 1
      max_attempts              = 5
      min_backoff               = "60s"
      max_backoff               = "3600s"
      max_doublings             = 3
      max_retry_duration        = "14400s"
      handler_path              = "/api/tasks/billing"
      priority                  = "low"
    }

    # Per Correction Protocol: Rate-limited correction execution queue
    # Lower rate to avoid overwhelming external APIs during bulk corrections
    "correction-tasks" = {
      max_concurrent_dispatches = 5
      max_dispatches_per_second = 2
      max_attempts              = 5
      min_backoff               = "30s"
      max_backoff               = "1800s" # 30 minutes max backoff
      max_doublings             = 4
      max_retry_duration        = "7200s" # 2 hours
      handler_path              = "/api/tasks/correction"
      priority                  = "medium"
    }

    # Agent chat message processing queue
    # Medium concurrency for real-time chat interactions with agents
    "chat-tasks" = {
      max_concurrent_dispatches = 50
      max_dispatches_per_second = 100
      max_attempts              = 3
      min_backoff               = "1s"
      max_backoff               = "30s"
      max_doublings             = 3
      max_retry_duration        = "300s" # 5 minutes
      handler_path              = "/api/tasks/chat"
      priority                  = "high"
    }

    # Claude Agent SDK execution queue
    # Lower concurrency (SDK sessions are long-running), fewer retries (SDK has internal retry)
    "sdk-agent-execution" = {
      max_concurrent_dispatches = 20
      max_dispatches_per_second = 20
      max_attempts              = 3
      min_backoff               = "10s"
      max_backoff               = "600s"
      max_doublings             = 3
      max_retry_duration        = "7200s"
      handler_path              = "/api/tasks/sdk-execute"
      priority                  = "high"
    }
  }

  # Environment-specific scaling
  env_scale_factor = {
    dev     = 0.1
    staging = 0.5
    prod    = 1.0
  }

  scale_factor = lookup(local.env_scale_factor, var.environment, 1.0)
}

# Create queues with specific configurations
resource "google_cloud_tasks_queue" "queues" {
  for_each = local.queue_configs

  project  = var.project_id
  location = var.region
  # v2 suffix added to avoid GCP tombstone (deleted queues cannot be recreated for 7 days)
  name = var.tenant_id != "" ? "${var.tenant_id}-${each.key}-${var.environment}-v2" : "${each.key}-${var.environment}-v2"

  rate_limits {
    max_concurrent_dispatches = ceil(each.value.max_concurrent_dispatches * local.scale_factor)
    max_dispatches_per_second = ceil(each.value.max_dispatches_per_second * local.scale_factor)
  }

  retry_config {
    max_attempts       = each.value.max_attempts
    min_backoff        = each.value.min_backoff
    max_backoff        = each.value.max_backoff
    max_doublings      = each.value.max_doublings
    max_retry_duration = each.value.max_retry_duration
  }

  # maintenance-tasks is logged in full: it carries the maintenance that used
  # to run on Cloud Scheduler, a few dozen tasks a day, and an attempt's log
  # line is the only record that it ran. The busy queues keep a sample.
  stackdriver_logging_config {
    sampling_ratio = var.environment != "prod" || each.key == "maintenance-tasks" ? 1.0 : 0.1
  }
}

# IAM: Allow service account to enqueue tasks
resource "google_cloud_tasks_queue_iam_member" "enqueuer" {
  for_each = local.queue_configs

  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.queues[each.key].name
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${var.service_account_email}"
}

# IAM: Allow service account to view tasks
resource "google_cloud_tasks_queue_iam_member" "viewer" {
  for_each = local.queue_configs

  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.queues[each.key].name
  role     = "roles/cloudtasks.viewer"
  member   = "serviceAccount:${var.service_account_email}"
}

# IAM: Allow service account to delete tasks (for cancellation)
resource "google_cloud_tasks_queue_iam_member" "deleter" {
  for_each = local.queue_configs

  project  = var.project_id
  location = var.region
  name     = google_cloud_tasks_queue.queues[each.key].name
  role     = "roles/cloudtasks.taskDeleter"
  member   = "serviceAccount:${var.service_account_email}"
}

# Outputs
output "queues" {
  description = "Queue IDs by name"
  value       = { for k, v in google_cloud_tasks_queue.queues : k => v.id }
}

output "queue_names" {
  description = "Queue names"
  value       = { for k, v in google_cloud_tasks_queue.queues : k => v.name }
}

output "queue_configs" {
  description = "Queue configurations including handler paths"
  value = { for k, v in google_cloud_tasks_queue.queues : k => {
    name         = v.name
    handler_path = local.queue_configs[k].handler_path
    priority     = local.queue_configs[k].priority
  } }
}

output "high_priority_queues" {
  description = "High priority queue names"
  value       = [for k, v in google_cloud_tasks_queue.queues : v.name if local.queue_configs[k].priority == "high"]
}

output "low_priority_queues" {
  description = "Low priority queue names"
  value       = [for k, v in google_cloud_tasks_queue.queues : v.name if local.queue_configs[k].priority == "low"]
}
