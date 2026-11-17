# connector-service-security: Phase 4 Security Hardening
# VPC Service Controls perimeter for the Connector Service.
#
# What this module does:
#   1. Creates a VPC-SC service perimeter that wraps the Connector Service project.
#   2. Adds an ingress policy allowing only authorized tenant-runtime callers.
#   3. Restricts secretmanager, run, and cloudfunctions from exfiltration paths.
#
# Prerequisites (fill in before applying):
#   - var.access_policy_name must point to an existing Access Context Manager policy.
#   - var.org_id must be the numeric organization ID (not "organizations/xxx").
#   - var.allowed_caller_projects must list the project numbers of tenant-runtime
#     projects that are permitted to call the Connector Service.
#   - var.connector_service_sa_email must be the actual Connector Service SA email.
#
# TODO before production:
#   - Confirm the Access Context Manager policy is the org-level policy (not a
#     folder-level one) — the perimeter resource name is constructed from it.
#   - Add STS (Workload Identity Federation) binding reference once the WIF pool
#     is provisioned; see outputs.tf for the placeholder output.
#   - Review restricted_services list — add or remove based on what APIs the
#     Connector Service uses internally.
#   - Validate that the ingress access level condition correctly covers all tenant
#     SA emails. Currently uses ANY_SERVICE_ACCOUNT from allowed_caller_projects.

locals {
  # Per existing vpc-service-controls module convention
  is_enabled = var.enabled != null ? var.enabled : (var.environment == "prod")

  perimeter_name_slug = "connector_service_${replace(lower(var.environment), "-", "_")}"
}

# ─── Connector Service access level ───────────────────────────────────────────
# Grants the Connector Service SA an access level so it can egress from the
# perimeter to Secret Manager and other GCP APIs without being blocked.

resource "google_access_context_manager_access_level" "connector_service_sa" {
  count = local.is_enabled ? 1 : 0

  # TODO: Replace "TODO_ACCESS_POLICY_ID" with the numeric policy ID from your
  # Access Context Manager policy once you have run:
  #   gcloud access-context-manager policies list --organization=<org_id>
  parent = "accessPolicies/${var.access_policy_name}"
  name   = "accessPolicies/${var.access_policy_name}/accessLevels/connector_service_${var.environment}"
  title  = "Connector Service SA — ${var.environment}"

  basic {
    conditions {
      members = concat(
        ["serviceAccount:${var.connector_service_sa_email}"],
        var.admin_members,
      )
    }
  }
}

# ─── VPC-SC perimeter for Connector Service ───────────────────────────────────

resource "google_access_context_manager_service_perimeter" "connector_service" {
  count = local.is_enabled ? 1 : 0

  parent = "accessPolicies/${var.access_policy_name}"
  name   = "accessPolicies/${var.access_policy_name}/servicePerimeters/${local.perimeter_name_slug}"
  title  = "Connector Service — ${var.environment}"

  # Use ENFORCE mode in prod, DRY_RUN in dev/staging so we can audit before locking
  # TODO: Change to "ENFORCE" once dry-run audit confirms no false positives
  perimeter_type = "PERIMETER_TYPE_REGULAR"

  status {
    resources = ["projects/${var.project_id}"]

    restricted_services = var.restricted_services

    access_levels = [
      google_access_context_manager_access_level.connector_service_sa[0].name,
    ]

    vpc_accessible_services {
      enable_restriction = true
      # RESTRICTED-SERVICES covers the perimeter's restricted_services; extra
      # services (e.g. storage.googleapis.com for the agent-diagnostics job's
      # GCS scorecard sink) are appended so in-VPC workloads can reach them.
      allowed_services = concat(["RESTRICTED-SERVICES"], var.additional_vpc_accessible_services)
    }

    # Ingress #1: allow authorized tenant-runtime callers to
    #   (a) invoke connector-service / governance-engine Cloud Run
    #   (b) read the cross-project service tokens from Secret Manager at boot
    #
    # The tenant-runtime SA reads `connector-service-token` and
    # `governance-engine-token` from Secret Manager in the platform-control
    # project at boot (see SECRET_MANIFEST in tenant-runtime
    # `src/infrastructure/secrets.ts`) so it can satisfy the X-Service-Auth
    # header on every Connect-RPC call. Without secretmanager.googleapis.com
    # in the allowed operations here VPC-SC rejects the read with
    # NETWORK_NOT_IN_SAME_SERVICE_PERIMETER, the token is never set, every
    # RPC arrives with no auth header, and users see "no MCP tools available".
    #
    # Note: identity-based ingress via access_level does not work for this
    # case — access levels with only a members condition are treated as
    # having no network match and fail the perimeter check. ANY_SERVICE_ACCOUNT
    # from a specific source project is the documented pattern.
    dynamic "ingress_policies" {
      for_each = length(var.allowed_caller_projects) > 0 ? [1] : []
      content {
        ingress_from {
          # ANY_SERVICE_ACCOUNT from the listed source projects.
          # TODO: Narrow to specific tenant-runtime SA emails once the per-tenant
          # SA provisioning lands — replace identity_type with explicit identities list.
          identity_type = "ANY_SERVICE_ACCOUNT"

          dynamic "sources" {
            for_each = var.allowed_caller_projects
            content {
              resource = "projects/${sources.value}"
            }
          }
        }

        ingress_to {
          resources = ["*"]
          operations {
            # Allow invocation of the Connector Service / Governance Engine
            # Cloud Run endpoints.
            service_name = "run.googleapis.com"
            method_selectors {
              method = "*"
            }
          }
          operations {
            # Allow reading the cross-project service tokens
            # (connector-service-token, governance-engine-token) at boot.
            # Individual secret access is still gated by
            # secretmanager.secretAccessor IAM bindings — VPC-SC only
            # controls network reachability.
            service_name = "secretmanager.googleapis.com"
            method_selectors {
              method = "*"
            }
          }
        }
      }
    }

    # Ingress #2: allow human admins to manage all restricted services
    # inside the perimeter (Cloud Run, Secret Manager, Cloud Functions).
    # Gate on the connector_service_prod access level (which lists the
    # admin member set) so only authorized identities come through.
    # Without this, `gcloud run/secrets describe|create|set-iam-policy`
    # from a workstation is blocked, which breaks terraform applies
    # and day-2 operations.
    dynamic "ingress_policies" {
      for_each = length(var.admin_members) > 0 ? [1] : []
      content {
        ingress_from {
          identity_type = "ANY_IDENTITY"
          sources {
            access_level = google_access_context_manager_access_level.connector_service_sa[0].name
          }
        }

        ingress_to {
          resources = ["*"]
          dynamic "operations" {
            for_each = var.restricted_services
            content {
              service_name = operations.value
              method_selectors {
                method = "*"
              }
            }
          }
        }
      }
    }

    # Egress: allow Connector Service to call Secret Manager for credential reads
    egress_policies {
      egress_from {
        # identity_type is omitted deliberately: with an explicit `identities`
        # list the type defaults to IDENTITY_TYPE_UNSPECIFIED, and the API does
        # not persist that default. Declaring it explicitly caused a perpetual
        # "+ identity_type = IDENTITY_TYPE_UNSPECIFIED" diff on every plan.
        identities = ["serviceAccount:${var.connector_service_sa_email}"]
      }
      egress_to {
        resources = ["*"]
        operations {
          service_name = "secretmanager.googleapis.com"
          method_selectors {
            method = "*"
          }
        }
      }
    }
  }
}
