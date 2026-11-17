# Cloud SQL for PostgreSQL Module
# Per Section 5: Connection budgeting and managed connection pooling

variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "environment" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "max_connections" {
  description = "Maximum connections for Cloud SQL instance"
  type        = number
  default     = 200
}

variable "tier" {
  description = "Cloud SQL instance tier"
  type        = string
  default     = "db-custom-1-3840"
}

variable "network_id" {
  description = "VPC network ID for private IP connectivity"
  type        = string
  default     = ""
}

variable "private_network_name" {
  description = "VPC network name for private IP connectivity"
  type        = string
  default     = ""
}

variable "dr_region" {
  description = "Disaster recovery region for cross-region backups and read replica"
  type        = string
  default     = ""
}

variable "enable_read_replica" {
  description = "Enable cross-region read replica for DR"
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Terraform-side deletion protection. Off only to retire an instance whose data has moved."
  type        = bool
  default     = true
}

variable "encryption_key_name" {
  description = "CMEK encryption key for Cloud SQL (per Section 20). Format: projects/{project}/locations/{region}/keyRings/{keyring}/cryptoKeys/{key}"
  type        = string
  default     = ""
}

locals {
  instance_name   = "${var.name_prefix}-pg-${var.environment}"
  private_network = var.network_id != "" ? var.network_id : "projects/${var.project_id}/global/networks/default"
  # Enable DR features only for prod with a DR region specified
  enable_dr = var.environment == "prod" && var.dr_region != ""
}

resource "google_sql_database_instance" "main" {
  project          = var.project_id
  name             = local.instance_name
  database_version = "POSTGRES_15"
  region           = var.region

  # Per Section 20: CMEK encryption for Cloud SQL
  encryption_key_name = var.encryption_key_name != "" ? var.encryption_key_name : null

  settings {
    tier              = var.tier
    availability_type = "ZONAL" # no standby until there is load to protect

    # Managed connection pooling per Section 5
    database_flags {
      name  = "max_connections"
      value = var.max_connections
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = var.environment == "prod"
      start_time                     = "03:00"
      transaction_log_retention_days = var.environment == "prod" ? 7 : 1

      backup_retention_settings {
        retained_backups = var.environment == "prod" ? 30 : 7
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled = false
      # Private IP for Cloud Run connectivity
      private_network = local.private_network
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
      record_client_address   = true
    }
  }

  # CRITICAL: protect against accidental deletion - tenant data. Off only to
  # retire an instance whose data has moved (var.deletion_protection).
  deletion_protection = var.deletion_protection

  # scripts/dev-power.sh stops and starts the dev instances; an apply must not
  # restart a sleeping one.
  lifecycle {
    ignore_changes = [settings[0].activation_policy]
  }
}

# Default database
resource "google_sql_database" "main" {
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  name     = "liftoff"
}

# -----------------------------------------------------------------------------
# Disaster Recovery - Read Replica in DR Region
# Per Section 19: Multi-region for disaster recovery
# -----------------------------------------------------------------------------

resource "google_sql_database_instance" "read_replica" {
  count = local.enable_dr && var.enable_read_replica ? 1 : 0

  project              = var.project_id
  name                 = "${local.instance_name}-replica"
  database_version     = "POSTGRES_15"
  region               = var.dr_region
  master_instance_name = google_sql_database_instance.main.name

  # Per Section 20: CMEK encryption for read replica
  # Note: Read replica must use same key or a key in the DR region
  encryption_key_name = var.encryption_key_name != "" ? var.encryption_key_name : null

  replica_configuration {
    failover_target = true
  }

  settings {
    tier              = var.tier
    availability_type = "ZONAL" # Read replica in single zone

    ip_configuration {
      ipv4_enabled    = false
      private_network = local.private_network
    }

    database_flags {
      name  = "max_connections"
      value = var.max_connections
    }
  }

  deletion_protection = var.environment == "prod"

  depends_on = [google_sql_database_instance.main]
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "instance_name" {
  value = google_sql_database_instance.main.name
}

output "instance_ip" {
  value = google_sql_database_instance.main.private_ip_address
}

output "read_replica_connection_name" {
  value = local.enable_dr && var.enable_read_replica ? google_sql_database_instance.read_replica[0].connection_name : ""
}

output "read_replica_ip" {
  value = local.enable_dr && var.enable_read_replica ? google_sql_database_instance.read_replica[0].private_ip_address : ""
}
