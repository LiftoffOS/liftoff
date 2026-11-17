# Push-endpoint healthcheck Cloud Run Job. Run by cloudbuild AFTER
# patch-push-sub-endpoints; fails the deploy if any control-plane push
# subscription still has a placeholder endpoint or its /healthz is unreachable.
#
# Defends against a pattern that makes events vanish: subscription created
# with placeholder, patch step delayed/missed, every push 5xx's, messages age
# out of DLQ.

resource "google_service_account" "push_endpoint_healthcheck" {
  project      = google_project.tenant_runtime.project_id
  account_id   = "push-healthcheck-${var.environment}"
  display_name = "Push-endpoint healthcheck — ${var.environment}"
  description  = "Lists Pub/Sub subscriptions + probes coordinator-service /healthz on tenant-runtime deploy. Fails the deploy if any control-plane push sub is still pointed at placeholder.invalid."
}

# pubsub.viewer on the tenant project so it can list subscriptions
resource "google_project_iam_member" "push_healthcheck_pubsub_viewer" {
  project = google_project.tenant_runtime.project_id
  role    = "roles/pubsub.viewer"
  member  = "serviceAccount:${google_service_account.push_endpoint_healthcheck.email}"
}

# Cross-project: platform-backend-sa needs run.viewer on this tenant project
# so its validate-tenant-runtime-urls job can list Cloud Run services and
# derive the expected agent-service URL. Companion to the platform_backend_cloud_run_viewer
# binding in platform-control/pubsub_bulletproof.tf.
resource "google_project_iam_member" "platform_backend_views_tenant_run" {
  count   = var.platform_backend_sa != "" ? 1 : 0
  project = google_project.tenant_runtime.project_id
  role    = "roles/run.viewer"
  member  = "serviceAccount:${var.platform_backend_sa}"
}

# run.invoker on coordinator-service so the /healthz probe authenticates
resource "google_cloud_run_service_iam_member" "push_healthcheck_invokes_coordinator" {
  count    = var.split_services_deployed ? 1 : 0
  project  = google_project.tenant_runtime.project_id
  location = var.region
  service  = "coordinator-service"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.push_endpoint_healthcheck.email}"

  depends_on = [google_cloud_run_v2_service.coordinator_service]
}

# Data source — reads the live coordinator-service image so the healthcheck
# Job runs the SAME image (zero version skew). Gated on split_services_deployed
# so first-ever applies (when the service does not yet exist) don't fail.
data "google_cloud_run_v2_service" "coordinator" {
  count    = var.split_services_deployed ? 1 : 0
  project  = google_project.tenant_runtime.project_id
  location = var.region
  name     = "coordinator-service"
}

resource "google_cloud_run_v2_job" "push_endpoint_healthcheck" {
  count    = var.split_services_deployed ? 1 : 0
  project  = google_project.tenant_runtime.project_id
  location = var.region
  name     = "push-endpoint-healthcheck-${var.environment}"

  template {
    template {
      service_account = google_service_account.push_endpoint_healthcheck.email
      timeout         = "120s"
      max_retries     = 0

      # coordinator-service has ingress=internal — calls from outside the VPC
      # are 404'd at the load balancer (looks like a missing route from
      # outside). Route the Job through the tenant VPC (Direct VPC egress) so
      # the probe lands on the internal Cloud Run endpoint. egress=ALL_TRAFFIC
      # so the Cloud Run public hostname is reached from inside the VPC.
      vpc_access {
        network_interfaces {
          network    = google_compute_network.tenant_vpc.id
          subnetwork = google_compute_subnetwork.tenant_subnet.id
        }
        egress = "ALL_TRAFFIC"
      }

      containers {
        # Same image as coordinator-service — extra dist/scripts/ entrypoint.
        image   = data.google_cloud_run_v2_service.coordinator[0].template[0].containers[0].image
        command = ["node"]
        args    = ["dist/scripts/push-endpoint-healthcheck.js"]

        env {
          name  = "TENANT_PROJECT"
          value = google_project.tenant_runtime.project_id
        }
        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }

        resources {
          limits = {
            cpu = "1"
            # 512Mi is the minimum for gen2 unthrottled (CPU-always-allocated)
            # Cloud Run Jobs. The default execution environment for Jobs is
            # gen2 with unthrottled CPU; smaller memory limits are rejected at
            # apply time. 512Mi is well above what the healthcheck needs.
            memory = "512Mi"
          }
        }
      }
    }
  }

  lifecycle {
    # cloudbuild owns the image SHA via the coordinator-service container image
    # data source; don't trip drift on every Terraform plan. client/client_version
    # are stamped by gcloud run deploy — ignore them too.
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_iam_member.push_healthcheck_pubsub_viewer,
  ]
}
