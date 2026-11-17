# Phase 4 Split Services
#
# The tenant-runtime Docker image is deployed as four Cloud Run services
# alongside the monolith:
#   - agent-service         — invocation surface (ingress ALL, platform-backend cross-project)
#   - coordinator-service   — orchestration + control-plane subscribers
#   - tool-gateway-service  — tool routing + connector proxy
#   - reflection-service    — reflection engine (heavy, low concurrency)
#
# Ownership model:
#   - Terraform owns: service resource, ingress, scaling, VPC access, resource
#     limits, service account, volumes, timeout, concurrency, and the
#     bootstrap SERVICE_TYPE env var.
#   - Cloudbuild owns: image tag (rolled on every push) + the full env var
#     set + secrets (DB_PASSWORD, tokens, API keys, peer URLs).
#
# `lifecycle.ignore_changes` on `image` and `env` prevents Terraform apply
# from reverting cloudbuild's image + env updates. Peer URLs (AGENT_SERVICE_URL
# etc.) are patched by cloudbuild's `patch-split-service-urls` step — putting
# them in Terraform would create a cycle (agent depends on coordinator URL
# which depends on agent URL) so Terraform seeds empty placeholders and
# ignores the attribute thereafter.
#
# The gate variable `split_services_deployed` (declared in main.tf) is TRUE
# once cloudbuild has pushed its first image; before that, Terraform has
# nothing to create. After that, every apply is idempotent — Terraform
# enforces structure while cloudbuild keeps the image + env current.

locals {
  # Shared values for all four split services.
  tenant_runtime_sa_email = module.iam.tenant_runtime_sa
  split_service_labels = {
    environment = var.environment
    managed-by  = "terraform"
    tenant-id   = var.tenant_id
    phase       = "4-split-services"
  }

  # Placeholder image used on first-apply before cloudbuild pushes the real
  # tenant-runtime image. Cloud Run's placeholder serves a 200 OK on / so
  # the service reaches RUNNING state and cloudbuild can then `gcloud run
  # deploy --image=$SHORT_SHA` onto it.
  split_service_placeholder_image = "gcr.io/cloudrun/placeholder"
}

# -----------------------------------------------------------------------------
# agent-service (8Gi/4cpu, min=0, concurrency=40, timeout=900s, ingress=ALL)
# Live values come from the tenant-runtime repo's cloudbuild.yaml (see the
# ignore_changes block below); this header tracks them for readers.
# -----------------------------------------------------------------------------
# Ingress = ALL so platform-backend-sa (in YOUR_GCP_PROJECT) can
# invoke cross-project once traffic cuts over from the monolith (plan §4f §2).
# Auth is enforced by Cloud Run IAM: platform_backend_agent_invoker binds
# run.invoker, and app-layer requireServiceAuth protects the route.
resource "google_cloud_run_v2_service" "agent_service" {
  count    = var.split_services_deployed ? 1 : 0
  project  = google_project.tenant_runtime.project_id
  name     = "agent-service"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  labels = merge(local.split_service_labels, { service = "agent-service" })

  template {
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    service_account                  = local.tenant_runtime_sa_email
    max_instance_request_concurrency = 80
    # Kept in step with cloudbuild.yaml's `--timeout` for agent-service, which is
    # the value that actually takes effect (timeout is in ignore_changes below).
    # A chat turn that browses or sweeps an API runs well past the old 300s.
    timeout = "900s"

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    vpc_access {

      network_interfaces {

        network = google_compute_network.tenant_vpc.id

        subnetwork = google_compute_subnetwork.tenant_subnet.id

      }
      egress = "ALL_TRAFFIC"
    }

    # Note: the 2Gi in-memory /tmp volume is added by cloudbuild's deploy step
    # via --add-volume / --add-volume-mount. Keeping it out of Terraform avoids
    # provider-version incompatibility with google 5.x's volumes schema, and
    # the `ignore_changes` on volumes + volume_mounts below prevents apply
    # from reverting cloudbuild's additions.

    containers {
      image = local.split_service_placeholder_image

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
      }

      env {
        name  = "SERVICE_TYPE"
        value = "agent"
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    module.iam,
  ]

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].containers[0].resources,
      template[0].containers[0].liveness_probe,
      template[0].containers[0].startup_probe,
      template[0].containers[0].volume_mounts,
      template[0].volumes,
      # Scaling + timeout + concurrency belong to the tenant-runtime repo's
      # cloudbuild.yaml — per-service tuning lives there with the code, and
      # a mismatched default here causes every infrastructure-apply to reset
      # what cloudbuild just set.
      template[0].scaling,
      template[0].timeout,
      template[0].max_instance_request_concurrency,
      template[0].vpc_access,
      # client_version drifts on every `gcloud run deploy` — ignore to keep
      # plans clean.
      client,
      client_version,
    ]
  }
}

# -----------------------------------------------------------------------------
# coordinator-service (1Gi/1cpu, min=1, concurrency=40, timeout=600s)
# IMPORTANT: coordinator requires min_instances=1 and cpu-throttling=false because it
# runs a Pub/Sub streaming pull that dies when the process is idle. These are set via
# gcloud (not Terraform) and preserved by ignore_changes on scaling/template below.
# To apply: gcloud run services update coordinator-service --no-cpu-throttling --min-instances=1
# -----------------------------------------------------------------------------
resource "google_cloud_run_v2_service" "coordinator_service" {
  count    = var.split_services_deployed ? 1 : 0
  project  = google_project.tenant_runtime.project_id
  name     = "coordinator-service"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  labels = merge(local.split_service_labels, { service = "coordinator-service" })

  template {
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    service_account                  = local.tenant_runtime_sa_email
    max_instance_request_concurrency = 40
    timeout                          = "600s"

    scaling {
      min_instance_count = 1
      max_instance_count = 5
    }

    vpc_access {

      network_interfaces {

        network = google_compute_network.tenant_vpc.id

        subnetwork = google_compute_subnetwork.tenant_subnet.id

      }
      egress = "ALL_TRAFFIC"
    }

    containers {
      image = local.split_service_placeholder_image

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      env {
        name  = "SERVICE_TYPE"
        value = "coordinator"
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    module.iam,
  ]

  lifecycle {
    ignore_changes = [
      # Cloudbuild owns the image + env + secrets AND all per-deploy runtime
      # tuning. min_instances/cpu-throttling AND concurrency are set via gcloud
      # (cpu_idle isn't in the pinned provider; concurrency=8 is tuned for the
      # Pub/Sub streaming pull), so Terraform must ignore them or every apply
      # resets what cloudbuild just set. Mirrors agent_service.
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].containers[0].resources,
      template[0].containers[0].liveness_probe,
      template[0].containers[0].startup_probe,
      template[0].containers[0].volume_mounts,
      template[0].volumes,
      template[0].scaling,
      template[0].timeout,
      template[0].max_instance_request_concurrency,
      template[0].vpc_access,
      client,
      client_version,
    ]
  }
}

# -----------------------------------------------------------------------------
# tool-gateway-service (1Gi/1cpu, min=0, concurrency=200, timeout=60s)
# -----------------------------------------------------------------------------
resource "google_cloud_run_v2_service" "tool_gateway_service" {
  count    = var.split_services_deployed ? 1 : 0
  project  = google_project.tenant_runtime.project_id
  name     = "tool-gateway-service"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  labels = merge(local.split_service_labels, { service = "tool-gateway-service" })

  template {
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    service_account                  = local.tenant_runtime_sa_email
    max_instance_request_concurrency = 200
    timeout                          = "60s"

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    vpc_access {

      network_interfaces {

        network = google_compute_network.tenant_vpc.id

        subnetwork = google_compute_subnetwork.tenant_subnet.id

      }
      egress = "ALL_TRAFFIC"
    }

    containers {
      image = local.split_service_placeholder_image

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }

      env {
        name  = "SERVICE_TYPE"
        value = "tool-gateway"
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    module.iam,
  ]

  lifecycle {
    ignore_changes = [
      # Cloudbuild owns the image + env + secrets AND all per-deploy runtime
      # tuning (scaling/concurrency/timeout/vpc/volumes) — per-service tuning
      # lives with the code in cloudbuild.yaml. Terraform only enforces the
      # service's existence + identity. Mirrors agent_service so an
      # infrastructure-apply never reverts what cloudbuild just deployed.
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].containers[0].resources,
      template[0].containers[0].liveness_probe,
      template[0].containers[0].startup_probe,
      template[0].containers[0].volume_mounts,
      template[0].volumes,
      template[0].scaling,
      template[0].timeout,
      template[0].max_instance_request_concurrency,
      template[0].vpc_access,
      client,
      client_version,
    ]
  }
}

# -----------------------------------------------------------------------------
# reflection-service (4Gi/4cpu, min=0, concurrency=10, timeout=900s)
# -----------------------------------------------------------------------------
# Heavy resource profile: Claude Opus reflection analysis needs headroom. Low
# concurrency (10) prevents a single instance from starving concurrent Opus
# calls of CPU. min_instance_count=0 is intentional — reflection runs
# asynchronously via Cloud Tasks, no cold-start latency matters.
resource "google_cloud_run_v2_service" "reflection_service" {
  count    = var.split_services_deployed ? 1 : 0
  project  = google_project.tenant_runtime.project_id
  name     = "reflection-service"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  labels = merge(local.split_service_labels, { service = "reflection-service" })

  template {
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    service_account                  = local.tenant_runtime_sa_email
    max_instance_request_concurrency = 10
    timeout                          = "900s"

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    vpc_access {

      network_interfaces {

        network = google_compute_network.tenant_vpc.id

        subnetwork = google_compute_subnetwork.tenant_subnet.id

      }
      egress = "ALL_TRAFFIC"
    }

    containers {
      image = local.split_service_placeholder_image

      resources {
        limits = {
          cpu    = "4"
          memory = "4Gi"
        }
      }

      env {
        name  = "SERVICE_TYPE"
        value = "reflection"
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    module.iam,
  ]

  lifecycle {
    ignore_changes = [
      # Cloudbuild owns the image + env + secrets AND all per-deploy runtime
      # tuning (scaling/concurrency/timeout/vpc/volumes) — per-service tuning
      # lives with the code in cloudbuild.yaml. Terraform only enforces the
      # service's existence + identity. Mirrors agent_service so an
      # infrastructure-apply never reverts what cloudbuild just deployed.
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].containers[0].resources,
      template[0].containers[0].liveness_probe,
      template[0].containers[0].startup_probe,
      template[0].containers[0].volume_mounts,
      template[0].volumes,
      template[0].scaling,
      template[0].timeout,
      template[0].max_instance_request_concurrency,
      template[0].vpc_access,
      client,
      client_version,
    ]
  }
}

# -----------------------------------------------------------------------------
# Outputs — split service URIs for downstream wiring
# -----------------------------------------------------------------------------

output "agent_service_url" {
  description = "Cloud Run URL of agent-service (set once split_services_deployed=true)."
  value       = var.split_services_deployed ? google_cloud_run_v2_service.agent_service[0].uri : ""
}

output "coordinator_service_url" {
  description = "Cloud Run URL of coordinator-service (set once split_services_deployed=true)."
  value       = var.split_services_deployed ? google_cloud_run_v2_service.coordinator_service[0].uri : ""
}

output "tool_gateway_service_url" {
  description = "Cloud Run URL of tool-gateway-service (set once split_services_deployed=true)."
  value       = var.split_services_deployed ? google_cloud_run_v2_service.tool_gateway_service[0].uri : ""
}

output "reflection_service_url" {
  description = "Cloud Run URL of reflection-service (set once split_services_deployed=true)."
  value       = var.split_services_deployed ? google_cloud_run_v2_service.reflection_service[0].uri : ""
}
