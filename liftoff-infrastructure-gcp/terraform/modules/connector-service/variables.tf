# connector-service: variables
# Reusable module for the Connector Service Cloud Run deployment.

variable "project_id" {
  description = "GCP project ID where the Connector Service is deployed (typically YOUR_GCP_PROJECT)"
  type        = string
}

variable "region" {
  description = "GCP region for the Connector Service and its Cloud SQL instance"
  type        = string
  default     = "us-west1"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "image" {
  description = <<-EOT
    Container image URL for the Connector Service.
    Example: us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT_STAGING/YOUR_ARTIFACT_REPO_STAGING/connector-service:latest
    When enabled = false this variable is not used but must still be provided.
  EOT
  type        = string
  default     = "us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT_STAGING/YOUR_ARTIFACT_REPO_STAGING/connector-service:latest"
}

variable "min_instances" {
  description = <<-EOT
    Minimum number of Cloud Run instances. Set to ≥ 1 in production to
    eliminate cold starts on the revenue path (per plan performance requirements).
  EOT
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Maximum number of Cloud Run instances for autoscaling"
  type        = number
  default     = 10
}

variable "platform_backend_sa_email" {
  description = <<-EOT
    Service account email of the Platform Backend. This SA is granted
    roles/run.invoker on the Connector Service so the Platform Backend
    can call it for credential pre-warming and batch execution.
  EOT
  type        = string
}

variable "network_id" {
  description = "VPC network ID for Cloud SQL private IP connectivity. Defaults to the project default network."
  type        = string
  default     = ""
}


variable "db_tier" {
  description = "Cloud SQL instance machine tier for connector-pg"
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_max_connections" {
  description = "max_connections setting for the connector-pg Cloud SQL instance"
  type        = number
  default     = 200
}

variable "db_app_password" {
  description = <<-EOT
    Password for the connector_app SQL user. Passed in from the parent
    project configuration where it is sourced from a random_password +
    Secret Manager secret (connector-pg-password). Marked sensitive.
  EOT
  type        = string
  sensitive   = true
}

variable "enabled" {
  description = <<-EOT
    Feature flag: whether to create the Connector Service Cloud Run resource
    and its Cloud SQL instance. Set to true when the Connector Service repo
    exists and is ready to deploy. Defaults to false so the module can be
    wired into environments without triggering premature resource creation.

    IAM and SA resources are always created (they cost nothing and are
    needed to wire per-tenant invoker grants ahead of the service going live).
  EOT
  type        = bool
  default     = false
}

variable "env_vars" {
  description = "Additional environment variables to pass to the Connector Service container"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secret Manager secrets to mount as environment variables in the Connector Service"
  type = list(object({
    name        = string
    secret_name = string
    version     = string
  }))
  default = []
}

variable "ingress" {
  description = <<-EOT
    Cloud Run ingress. INGRESS_TRAFFIC_ALL admits the run.app URL from the
    internet; INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER admits the external
    Application Load Balancer and same-project Google sources only, and is
    what closes the run.app path (it negotiates TLS 1.0). Never
    INGRESS_TRAFFIC_INTERNAL_ONLY: that blocks the load balancer and every
    cross-project caller (INV-INFRA-005).
  EOT
  type        = string
  default     = "INGRESS_TRAFFIC_ALL"
}

variable "sql_connection_name" {
  description = "Cloud SQL connection name of the instance holding the connector_service database (control-plane-pg)."
  type        = string
}

variable "vpc_network_id" {
  description = "VPC network for Direct VPC egress (replaces the Serverless VPC Access connector)."
  type        = string
}

variable "vpc_subnetwork_id" {
  description = "Subnetwork Cloud Run takes egress IPs from (Direct VPC egress)."
  type        = string
}
