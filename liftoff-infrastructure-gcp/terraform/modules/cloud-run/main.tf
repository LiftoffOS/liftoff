# Cloud Run Module

locals {
  # Default service limits — pool sizes kept small per instance so total
  # connections (max_instances × db_pool_size) stay within Cloud SQL limits.
  default_service_limits = {
    coordinator       = { max_instances = 1, db_pool_size = 8, priority = "high" }
    tenant-api        = { max_instances = 1, db_pool_size = 4, priority = "high" }
    action-ledger     = { max_instances = 1, db_pool_size = 8, priority = "high" }
    tool-gateway      = { max_instances = 1, db_pool_size = 3, priority = "normal" }
    reflection-engine = { max_instances = 1, db_pool_size = 3, priority = "low" }
    usage-ledger      = { max_instances = 1, db_pool_size = 4, priority = "normal" }
    connector-sync    = { max_instances = 1, db_pool_size = 3, priority = "low" }
    exports           = { max_instances = 1, db_pool_size = 2, priority = "low" }
    reporting         = { max_instances = 1, db_pool_size = 2, priority = "low" }
    reconciliation    = { max_instances = 1, db_pool_size = 2, priority = "low" }
  }

  # Per Section 5: Use service-specific limits or defaults
  service_config = lookup(local.default_service_limits, var.service_type, {
    max_instances = var.max_instances
    db_pool_size  = var.db_pool_size
    priority      = var.db_priority
  })

  # Use explicit values if provided, otherwise use service-type defaults
  effective_max_instances = var.max_instances != 1 ? var.max_instances : local.service_config.max_instances
  effective_db_pool_size  = var.db_pool_size != 5 ? var.db_pool_size : local.service_config.db_pool_size
  effective_db_priority   = var.db_priority != "normal" ? var.db_priority : local.service_config.priority

  # Merge custom labels with standard labels
  labels = merge({
    environment  = var.environment
    managed-by   = "terraform"
    service      = var.service_name
    db-priority  = local.effective_db_priority
    service-type = var.service_type
  }, var.tenant_id != "" ? { tenant-id = var.tenant_id, workspace-id = var.tenant_id } : {}, var.labels)
}

# Cloud Run Service
resource "google_cloud_run_v2_service" "service" {
  project  = var.project_id
  name     = var.service_name
  location = var.region
  ingress  = var.ingress

  labels = local.labels

  template {
    labels = local.labels

    service_account = var.service_account_email

    # R5 Fix 3: opt-in GEN2 execution environment (supported by provider 5.x)
    execution_environment = var.execution_environment != "" ? var.execution_environment : null

    # R5 BE-R4-002 + BE-R5-003 + Fix 1: termination_grace_period +
    # read_only_root_filesystem + tmpfs volume are NOT exposed by the
    # hashicorp/google provider v5.x for google_cloud_run_v2_service.
    # Applied as a post-deploy step via scripts/ops/apply-cloudrun-hardening.sh
    # which uses `gcloud run services replace` with a YAML patch. The module
    # vars `read_only_root_filesystem`, `tmpfs_mount_path`, `tmpfs_size_limit`,
    # `termination_grace_period_seconds` are honored by that script.

    # Per Section 5: Strict max-instance caps for connection budgeting
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = local.effective_max_instances
    }

    timeout = "${var.timeout}s"

    max_instance_request_concurrency = var.concurrency

    containers {
      image = var.image

      # R5 BE-R5-003: read-only root filesystem is NOT exposed by the
      # hashicorp/google terraform provider v5.x. Applied as a post-deploy
      # step via scripts/ops/apply-readonly-rootfs.sh (gcloud replace with
      # YAML). var.read_only_root_filesystem is honored by that script via
      # the run.googleapis.com/read-only-root-filesystem annotation.

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
        cpu_idle          = var.cpu_throttling
        startup_cpu_boost = var.startup_cpu_boost
      }

      # Per Section 5: Connection budget environment variables
      env {
        name  = "DB_POOL_SIZE"
        value = tostring(local.effective_db_pool_size)
      }

      env {
        name  = "DB_PRIORITY"
        value = local.effective_db_priority
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

      # Liveness probe
      liveness_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        period_seconds        = 30
        timeout_seconds       = 5
        failure_threshold     = 3
      }

      # Startup probe for slow-starting containers
      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 5
        period_seconds        = 10
        timeout_seconds       = 5
        failure_threshold     = 12
      }

      # Cloud SQL socket mount
      dynamic "volume_mounts" {
        for_each = length(var.cloudsql_connections) > 0 ? [1] : []
        content {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
      # R5 tmpfs volume_mount is applied via scripts/ops/apply-cloudrun-hardening.sh
      # (provider limitation — see top of template block).
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
    # R5 tmpfs volume applied via scripts/ops/apply-cloudrun-hardening.sh

    # Direct VPC egress for private networking
    dynamic "vpc_access" {
      for_each = var.vpc_network_id != "" ? [1] : []
      content {
        network_interfaces {
          network    = var.vpc_network_id
          subnetwork = var.vpc_subnetwork_id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    ignore_changes = [
      # Ignore changes to annotations made by GCP
      template[0].annotations,
      # Allow CI/CD to update the image
      template[0].containers[0].image,
    ]
  }
}

# IAM binding for service invokers
resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = toset(var.invokers)

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name
  role     = "roles/run.invoker"
  member   = each.value
}

# Allow unauthenticated access for public services (controlled via variable)
resource "google_cloud_run_v2_service_iam_member" "public" {
  count = contains(var.invokers, "allUsers") ? 0 : 0 # Disabled by default

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.service.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
