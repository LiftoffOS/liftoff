// -----------------------------------------------------------------------------
// Trajectory storage — cross-project write-only binding.
//
// The bucket `trajectories-${env}` lives in YOUR_GCP_PROJECT
// (defined in terraform/projects/platform-control/main.tf). Tenant-runtime writes
// agent trajectories into it but must never read or mutate existing objects, so
// it gets roles/storage.objectCreator (WRITE-ONLY) — not objectViewer/objectAdmin.
//
// The binding is granted from the tenant side (cross-project, referencing the
// bucket by literal name) because each tenant's runtime SA
// (module.iam.tenant_runtime_sa) is per-tenant and does not exist in the control
// project's scope. Mirrors the cross-project `control_plane_topic_viewer` grant
// in main.tf, which likewise references a control-project resource by name.
resource "google_storage_bucket_iam_member" "trajectories_writer" {
  bucket = "trajectories-${var.environment}"
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${module.iam.tenant_runtime_sa}"
}

// Runtime tenant UUID for the trajectory read-back condition. Trajectory
// objects are keyed by the RUNTIME tenant id (a DB-assigned UUID, e.g.
// `<tenant-uuid>/<agent>/<invocation>.jsonl`; see trajectories/sink.ts) — NOT the
// infra slug `var.tenant_id` ("liftoffos"). The template has no general way to
// know a tenant's runtime UUID, so the read-back grant is created only for
// tenants where this is supplied (for example, the eval tenant being harvested).
variable "trajectory_reader_tenant_uuid" {
  description = "Runtime tenant UUID whose own trajectory objects the runtime SA may read back (for the in-tenant diagnostics harvest). Empty → no read-back grant (write-only stays)."
  type        = string
  default     = ""
}

// Read-back of THIS tenant's own trajectories — required by the in-tenant
// diagnostics harvest, which reconstructs the lossless CanonicalTrajectory from
// GCS (the PRIMARY path; the raw-table fallback drops thinking blocks + the
// designed tools array that goal/conformance judging needs). Scoped by an IAM
// condition to the tenant's own runtime-UUID object prefix (see
// trajectories/sink.ts) so the write-only-bucket isolation between tenants is
// preserved — a tenant runtime can read back only its own runs, never another
// tenant's. Created only when trajectory_reader_tenant_uuid is set (the eval
// tenant). Without it, the harvest silently degrades reasoning runs to the
// minimal raw-table reconstruction (storage.objects.get denied → fallback).
resource "google_storage_bucket_iam_member" "trajectories_own_reader" {
  count  = var.trajectory_reader_tenant_uuid != "" ? 1 : 0
  bucket = "trajectories-${var.environment}"
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${module.iam.tenant_runtime_sa}"

  condition {
    title       = "own-tenant-trajectories-only"
    description = "Read access limited to this tenant's own trajectory object prefix."
    expression  = "resource.name.startsWith(\"projects/_/buckets/trajectories-${var.environment}/objects/${var.trajectory_reader_tenant_uuid}/\")"
  }
}

# Overwrite of the shared `diagnostics/` eval-substrate prefix. The collab-grade
# worker + the grader-calibration flow RE-GRADE existing sessions, and the sink
# (diagnostics/report/sink.ts) does an unconditional GCS object overwrite
# (`file().save()` with no precondition), which needs storage.objects.delete on
# top of the objectCreator (write-only) grant above. Without it a re-grade fails
# the sink with "does not have storage.objects.delete access" — and because the
# sink writes the rubric before the grade in one try block, that failure blocks
# the grade write too. Scoped by IAM condition to the shared `diagnostics/`
# prefix (the eval-internal namespace this SA already writes), so cross-TENANT
# isolation is preserved: customer trajectories live under their own <uuid>/
# prefixes, never diagnostics/. Only the eval tenant (which does the grading)
# gets this, gated on trajectory_reader_tenant_uuid like the reader above.
# NOTE: the normal fan-out grades only UNGRADED sessions (create, never
# overwrite); this covers re-grades and `--calibrate-grader`.
resource "google_storage_bucket_iam_member" "diagnostics_regrade_overwriter" {
  count  = var.trajectory_reader_tenant_uuid != "" ? 1 : 0
  bucket = "trajectories-${var.environment}"
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${module.iam.tenant_runtime_sa}"

  condition {
    title       = "diagnostics-eval-prefix-only"
    description = "Overwrite (create+delete) limited to the shared diagnostics/ eval-substrate prefix, so re-grades can replace grades/rubrics without touching any tenant trajectory."
    expression  = "resource.name.startsWith(\"projects/_/buckets/trajectories-${var.environment}/objects/diagnostics/\")"
  }
}
