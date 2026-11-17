// Cloud Build triggers for the sandbox-sidecar image (aio-sandbox).
// Dev fires on every push to main in liftoff-tenant-runtime that touches the
// sidecar tree. Prod fires on push to release branch.

resource "google_cloudbuild_trigger" "sandbox_sidecar_dev" {
  count    = var.environment == "dev" && var.github_repos_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "sandbox-sidecar-dev"
  location = var.region

  description = "Build aio-sandbox image on tenant-runtime main push"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-tenant-runtime"

    push {
      branch = "^main$"
    }
  }

  included_files = [
    "sandbox-sidecar/**",
    "packages/sandbox-validators/**",
    "packages/sandbox-contracts/**",
    "packages/agent-sdk/**",
  ]

  filename        = "sandbox-sidecar/cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _REGISTRY   = "us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT_STAGING/sandbox-images"
    _IMAGE_NAME = "aio-sandbox"
    _ENV        = "dev"
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloudbuild_trigger" "sandbox_sidecar_prod" {
  count    = var.environment == "prod" && var.github_repos_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "sandbox-sidecar-prod"
  location = var.region

  description = "Build aio-sandbox image on tenant-runtime release branch"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-tenant-runtime"

    push {
      branch = "^release$"
    }
  }

  included_files = [
    "sandbox-sidecar/**",
    "packages/sandbox-validators/**",
    "packages/sandbox-contracts/**",
    "packages/agent-sdk/**",
  ]

  filename        = "sandbox-sidecar/cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _REGISTRY   = "us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT/sandbox-images"
    _IMAGE_NAME = "aio-sandbox"
    _ENV        = "prod"
  }

  depends_on = [google_project_service.apis]
}
