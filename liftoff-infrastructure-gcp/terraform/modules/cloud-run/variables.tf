# Cloud Run Module Variables
# Per Section 5: Strict max-instance caps for connection budgeting

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for deployment"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "tenant_id" {
  description = "Tenant ID for tenant-specific deployments"
  type        = string
  default     = ""
}

variable "service_name" {
  description = "Name of the Cloud Run service"
  type        = string
}

variable "image" {
  description = "Container image URL"
  type        = string
}

variable "service_account_email" {
  description = "Service account email for the Cloud Run service"
  type        = string
}

variable "env_vars" {
  description = "Environment variables for the service"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secret Manager secrets to mount as env vars"
  type = list(object({
    name        = string
    secret_name = string
    version     = string
  }))
  default = []
}

variable "cloudsql_connections" {
  description = "Cloud SQL instance connection names"
  type        = list(string)
  default     = []
}


variable "ingress" {
  description = "Ingress settings: INGRESS_TRAFFIC_ALL, INGRESS_TRAFFIC_INTERNAL_ONLY, INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  type        = string
  default     = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
}

variable "min_instances" {
  description = "Minimum number of instances"
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum number of instances (for connection budgeting)"
  type        = number
  default     = 1
}

variable "cpu" {
  description = "CPU allocation per instance"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory allocation per instance"
  type        = string
  default     = "512Mi"
}

variable "timeout" {
  description = "Request timeout in seconds"
  type        = number
  default     = 300
}

variable "concurrency" {
  description = "Maximum concurrent requests per instance"
  type        = number
  default     = 80
}

variable "invokers" {
  description = "List of members allowed to invoke the service"
  type        = list(string)
  default     = []
}

variable "cpu_throttling" {
  description = "Whether CPU is throttled outside of requests"
  type        = bool
  default     = true
}

variable "startup_cpu_boost" {
  description = "Enable CPU boost during container startup"
  type        = bool
  default     = false
}

variable "labels" {
  description = "Labels to apply to the service"
  type        = map(string)
  default     = {}
}

# Per Section 5: Connection budgeting variables
variable "db_pool_size" {
  description = "Database connection pool size per instance. Part of connection budgeting strategy."
  type        = number
  default     = 5
}

variable "db_priority" {
  description = "Database client priority (high=coordinator/tenant-api/action-ledger, low=reflection/exports/reporting)"
  type        = string
  default     = "normal"
  validation {
    condition     = contains(["high", "normal", "low"], var.db_priority)
    error_message = "db_priority must be 'high', 'normal', or 'low'"
  }
}

variable "service_type" {
  description = "Logical service type for cost attribution billing labels (e.g. agent, coordinator, tool-gateway, reflection, platform)"
  type        = string
  default     = "platform"
}

# ── R5 Fix 3 / Fix 1 — Cloud Run hardening flags (opt-in per service) ──

variable "execution_environment" {
  description = "R5 Fix 3: Cloud Run execution environment. GEN2 required for read_only_root_filesystem + tmpfs."
  type        = string
  default     = ""
  validation {
    condition     = contains(["", "EXECUTION_ENVIRONMENT_GEN1", "EXECUTION_ENVIRONMENT_GEN2"], var.execution_environment)
    error_message = "execution_environment must be empty, EXECUTION_ENVIRONMENT_GEN1, or EXECUTION_ENVIRONMENT_GEN2."
  }
}

variable "read_only_root_filesystem" {
  description = "R5 BE-R5-003: mount the container's rootfs read-only. Requires execution_environment=GEN2. Use together with tmpfs_mount_path for writable scratch."
  type        = bool
  default     = false
}

variable "tmpfs_mount_path" {
  description = "R5 Fix 1: path at which to mount a tmpfs in-memory volume (e.g. /tmp for chat-thread workspaces). Empty disables."
  type        = string
  default     = ""
}

variable "tmpfs_size_limit" {
  description = "Size limit for the tmpfs volume (e.g. \"2Gi\"). Applies when tmpfs_mount_path is set."
  type        = string
  default     = "2Gi"
}

variable "termination_grace_period_seconds" {
  description = "R5 BE-R4-002: Cloud Run graceful shutdown window. Default 10s; tenant-runtime needs 30s for SIGTERM drain."
  type        = number
  default     = 0 # 0 = use Cloud Run default
}

variable "startup_probe_path" {
  description = "R5 Fix 3: startup probe HTTP path. Empty keeps /health default from container image config."
  type        = string
  default     = ""
}

variable "startup_probe_failure_threshold" {
  description = "Startup probe failure threshold (R5: 12 × 5s = 60s window for reaper + schema-check)."
  type        = number
  default     = 12
}

variable "vpc_network_id" {
  description = "VPC network for Direct VPC egress. Empty = no VPC egress."
  type        = string
  default     = ""
}

variable "vpc_subnetwork_id" {
  description = "Subnetwork Cloud Run takes egress IPs from (Direct VPC egress)."
  type        = string
  default     = ""
}
