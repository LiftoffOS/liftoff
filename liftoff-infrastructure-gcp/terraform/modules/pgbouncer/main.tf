# pgbouncer: shared transaction-mode pooler in front of control-plane-pg.
#
# DESIGN CHOICE — shared instance, not sidecar.
#   Plan 0d leaves the sidecar-vs-shared decision to 0d implementation.
#   We pick a shared Compute Engine MIG for these reasons:
#     1. Transaction-mode pooling works best with a single logical pooler
#        per backing DB. Sidecars per Cloud Run instance each open their
#        own PG backends, defeating the pool budget — seven services × N
#        Cloud Run instances would blow past control-plane-pg's
#        max_connections in minutes.
#     2. Per-service connection quotas (plan 0d) are trivially enforced
#        in a single pgbouncer.ini (pool_size per database); sidecars
#        would force the same config into N containers with no shared
#        ceiling.
#     3. Cloud Monitoring scraping of PgBouncer's SHOW STATS output is a
#        single target, not N.
#     4. Cost: one e2-standard-2 with a managed instance group for HA vs.
#        a sidecar per Cloud Run service × N replicas. Shared wins.
#   The tradeoff (a new moving part on the revenue path) is mitigated by
#   the MIG's regional HA posture and an auto-healing health check.
#
# Alert on >80% quota/service per plan 0d.

locals {
  labels = {
    service    = "pgbouncer"
    env        = var.environment
    managed_by = "terraform"
  }
  service_quota_total = length(var.service_quotas) == 0 ? 0 : sum([for v in values(var.service_quotas) : v])
  # Terraform can't fail-hard on mismatched sums at plan time without the
  # `check` block, which is ≥1.5. Emit a precondition on the MIG instead.
  pool_config = join("\n", [
    for svc, quota in var.service_quotas :
    "${svc} = host=${var.control_plane_sql_private_ip} port=5432 dbname=${svc == "platform-backend" ? "liftoff_control" : (svc == "connector" ? "connector_service" : (svc == "governance" ? "governance_engine" : svc))} pool_size=${quota}"
  ])
}

resource "google_compute_instance_template" "pgbouncer" {
  project     = var.project_id
  name_prefix = "pgbouncer-${var.environment}-"
  region      = var.region

  machine_type = "e2-standard-2"
  labels       = local.labels

  disk {
    source_image = "projects/cos-cloud/global/images/family/cos-stable"
    auto_delete  = true
    boot         = true
    disk_encryption_key {
      kms_key_self_link = var.kms_key_id
    }
  }

  network_interface {
    network    = var.network_id
    subnetwork = var.subnetwork_id
    # No external IP — private egress via Cloud NAT for image pulls.
  }

  service_account {
    email  = var.pgbouncer_sa_email
    scopes = ["cloud-platform"]
  }

  metadata = {
    # pgbouncer.ini is rendered into the container via a startup script.
    # The real file lives in this module's `templates/pgbouncer.ini.tpl`
    # — we inline the essential config here so the MIG has something to
    # consume without shipping extra files.
    pgbouncer-ini = <<-EOT
      [databases]
      ${local.pool_config}

      [pgbouncer]
      listen_addr = 0.0.0.0
      listen_port = 6432
      pool_mode = transaction
      max_client_conn = 1000
      default_pool_size = 20
      server_reset_query = DISCARD ALL
      ignore_startup_parameters = extra_float_digits,search_path
      admin_users = pgbouncer_admin
      stats_users = pgbouncer_stats
      auth_type = scram-sha-256
    EOT

    # Startup script launches two containers on the COS host:
    #   1. edoburu/pgbouncer — the pooler itself, listening on :6432.
    #   2. prometheuscommunity/pgbouncer-exporter — reads pgbouncer's
    #      stats DB over the pooler's admin socket and exposes
    #      Prometheus metrics on :9127. The OpsAgent running on every
    #      COS image scrapes :9127 and publishes it as
    #      custom.googleapis.com/pgbouncer/* (used by the alert policies
    #      below).
    # Images are pinned to digests so a vendor tag update cannot reach
    # prod without a terraform change.
    startup-script = <<-EOT
      #!/bin/bash
      set -euo pipefail
      mkdir -p /etc/pgbouncer
      curl -s -H "Metadata-Flavor: Google" \
        http://metadata.google.internal/computeMetadata/v1/instance/attributes/pgbouncer-ini \
        > /etc/pgbouncer/pgbouncer.ini
      curl -s -H "Metadata-Flavor: Google" \
        http://metadata.google.internal/computeMetadata/v1/instance/attributes/pgbouncer-userlist \
        > /etc/pgbouncer/userlist.txt
      chmod 600 /etc/pgbouncer/userlist.txt

      docker run -d --restart=always \
        --name pgbouncer \
        --network=host \
        -v /etc/pgbouncer:/etc/pgbouncer \
        ${var.pgbouncer_image}

      # pgbouncer-exporter connects to the pooler on localhost:6432 and
      # queries the admin `SHOW *` views. DATABASE_URL points at the
      # pgbouncer `pgbouncer` admin database (special name).
      docker run -d --restart=always \
        --name pgbouncer-exporter \
        --network=host \
        -e DATABASE_URL="postgres://${var.stats_user}:$(cat /etc/pgbouncer/stats-password)@127.0.0.1:6432/pgbouncer?sslmode=disable" \
        ${var.pgbouncer_exporter_image}

      # The Ops Agent scrape config is provisioned through
      # google_compute_project_metadata once per project. See
      # ops-agent/config.yaml committed alongside this module's README.
    EOT

    pgbouncer-userlist = var.pgbouncer_userlist
  }

  lifecycle {
    create_before_destroy = true
    precondition {
      condition     = local.service_quota_total == var.control_plane_sql_max_connections
      error_message = "Sum of service_quotas (${local.service_quota_total}) must equal control_plane_sql_max_connections (${var.control_plane_sql_max_connections}) per plan 0d."
    }
  }
}

resource "google_compute_region_instance_group_manager" "pgbouncer" {
  project            = var.project_id
  name               = "pgbouncer-${var.environment}"
  region             = var.region
  base_instance_name = "pgbouncer-${var.environment}"

  version {
    instance_template = google_compute_instance_template.pgbouncer.id
  }

  target_size = 2

  auto_healing_policies {
    health_check      = google_compute_health_check.pgbouncer.id
    initial_delay_sec = 60
  }

  named_port {
    name = "pgbouncer"
    port = 6432
  }
}

resource "google_compute_health_check" "pgbouncer" {
  project = var.project_id
  name    = "pgbouncer-${var.environment}-hc"

  tcp_health_check {
    port = 6432
  }

  check_interval_sec = 10
  timeout_sec        = 5
}

# ─── Alerts per plan 0d: >80% quota per service ──────────────────────────────
# Relies on pgbouncer-exporter (scraped to Cloud Monitoring) publishing
# per-database connection count as
# custom.googleapis.com/pgbouncer/client_active{database=<svc>}.
resource "google_monitoring_alert_policy" "quota_80pct" {
  for_each = var.service_quotas

  project      = var.project_id
  display_name = "PgBouncer quota 80% — ${each.key} (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "client_active > 80% of ${each.value}"
    condition_threshold {
      filter          = <<-EOT
        metric.type="custom.googleapis.com/pgbouncer/client_active"
        AND resource.type="global"
        AND metric.labels.database="${each.key}"
      EOT
      comparison      = "COMPARISON_GT"
      threshold_value = floor(each.value * 0.8)
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  notification_channels = var.notification_channels

  documentation {
    content   = "PgBouncer pool ${each.key} is >80% saturated (${each.value} slots). Runbook: docs/runbooks/pgbouncer-saturation.md"
    mime_type = "text/markdown"
  }
}

output "instance_group" {
  value = google_compute_region_instance_group_manager.pgbouncer.instance_group
}
