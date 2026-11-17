// Module-level provider declarations for the tenant-canary environment.
//
// Unlike tenant-runtime-template this module needs NO aliased
// google.platform_control provider — the canary is a fully self-contained
// throwaway project (its own SQL, AR, secret, SAs) and, because it runs the
// runtime with USE_CLOUD_TASKS_EXECUTION=false (in-process), it provisions no
// Pub/Sub push topology in the platform-control project.
//
// `random` backs the generated Postgres password (random_password).

terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.25, < 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.5"
    }
  }
}
