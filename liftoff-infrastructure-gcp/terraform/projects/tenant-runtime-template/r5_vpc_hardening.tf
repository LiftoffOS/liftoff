# R5 SE-R5-010 / R5 Fix 3: tenant-runtime VPC egress hardening.
#
# (P0.2) No `r5_block_tenant_runtime_metadata_v4` /
# `r5_block_tenant_runtime_metadata_v6` EGRESS firewalls (deny-all to
# 169.254.0.0/16 + RFC1918 + CGN, targeting the tenant-runtime SA). VPC egress
# firewalls CANNOT block Cloud Run's link-local metadata server: services running
# as the tenant-runtime SA reach metadata despite such a rule, and so does an
# in-sandbox curl. Such rules never fire. Metadata-token protection is now the P0.1 least-privilege
# `sandbox-runtime` SA (sandbox_runtime_sa.tf).
#
# The DNS response policy below is KEPT as harmless defense-in-depth. It is NOT a
# substitute for P0.1: the raw metadata IP (169.254.169.254) is still reachable, so
# the hostname block alone does not stop a determined caller.

# R5 SE-R5-010: DNS response policy returning NXDOMAIN for metadata hostnames.
# Defense-in-depth: makes metadata.google.internal resolution fail so agent code
# doesn't see a plausible IP. Note: there are no EGRESS firewalls backstopping
# this (see above) — the raw IP remains reachable, so this is a hostname-only
# speed bump, not a hard block.
resource "google_dns_response_policy" "r5_block_metadata" {
  provider             = google-beta
  project              = google_project.tenant_runtime.project_id
  response_policy_name = "r5-block-metadata"

  networks {
    network_url = google_compute_network.tenant_vpc.id
  }
}

resource "google_dns_response_policy_rule" "r5_block_metadata_internal" {
  provider        = google-beta
  project         = google_project.tenant_runtime.project_id
  response_policy = google_dns_response_policy.r5_block_metadata.response_policy_name
  rule_name       = "block-metadata-internal"
  dns_name        = "metadata.google.internal."

  local_data {
    local_datas {
      name    = "metadata.google.internal."
      type    = "A"
      ttl     = 300
      rrdatas = ["127.0.0.1"] # Blackhole to loopback — not reachable from tmpfs sandbox
    }
  }
}

resource "google_dns_response_policy_rule" "r5_block_metadata_server" {
  provider        = google-beta
  project         = google_project.tenant_runtime.project_id
  response_policy = google_dns_response_policy.r5_block_metadata.response_policy_name
  rule_name       = "block-metadata-server"
  dns_name        = "metadata."

  local_data {
    local_datas {
      name    = "metadata."
      type    = "A"
      ttl     = 300
      rrdatas = ["127.0.0.1"]
    }
  }
}
