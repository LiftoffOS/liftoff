# read-replica: one read replica on control-plane-pg (plan 0d).
# Consumed by billing (Stripe reconciliation scans). Writes continue to the primary.

locals {
  replica_name = "control-plane-pg-${var.environment}-replica"
  labels = {
    service    = "control-plane-pg"
    env        = var.environment
    managed_by = "terraform"
    role       = "read-replica"
  }
}

resource "google_sql_database_instance" "replica" {
  project              = var.project_id
  name                 = local.replica_name
  database_version     = "POSTGRES_15"
  region               = var.region
  master_instance_name = var.master_instance_name

  encryption_key_name = var.kms_key_name == "" ? null : var.kms_key_name

  replica_configuration {
    failover_target = false
  }

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = var.network_id
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
      record_client_address   = true
    }

    user_labels = local.labels
  }

  # Off so read_replica_enabled = false can remove it: the provider refuses to
  # destroy an instance whose state still says protected.
  deletion_protection = false

  lifecycle {
    ignore_changes = [settings[0].database_flags]
  }
}

output "connection_name" {
  value = google_sql_database_instance.replica.connection_name
}

output "private_ip" {
  value     = google_sql_database_instance.replica.private_ip_address
  sensitive = true
}
