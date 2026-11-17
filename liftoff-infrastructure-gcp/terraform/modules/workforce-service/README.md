# workforce-service

Terraform module for `liftoff-workforce-service` — HRBP provisioning + CAIO
draft orchestration. Phase 3 of platform-backend decomposition.

## What it provisions

- Service account `workforce-${env}`.
- Database `workforce` on the shared `control-plane-pg` (plan 0d).
- Role triad `workforce_migrate` / `workforce_app` / `workforce_readonly`.
- KMS key `workforce-key` in `keyring-${env}` (plan 0l).
- Secret Manager IAM scoped to `workforce-*` via IAM Condition (plan 0d).
- Cloud Run service `workforce`, `ingress=internal`, `min-instances=0`,
  `terminationGracePeriodSeconds=35`.
- Two cross-service env vars on the Cloud Run service so HRBP fan-out
  works end-to-end:
  - `WORKFORCE_SERVICE_URL` — self-target for Cloud Tasks; doubles as the
    OIDC audience the task handler verifies.
  - `WORKFORCE_SERVICE_ACCOUNT_EMAIL` — the SA whose OIDC token Cloud
    Tasks signs each fan-out task with.

  Note: the inbound + outbound service-auth token (`WORKFORCE_SERVICE_TOKEN`,
  backed by the pre-existing `workforce-service-token` Secret Manager secret)
  is mounted by cloudbuild's `--update-secrets` step, not this module, so
  the two layers don't fight over the same env slot.
- Cloud Build trigger, Binary Authorization attestor.
- Dashboard + SLOs (HRBP provisioning > 95%, CAIO draft TTFB p50 < 10s) +
  burn-rate alerts.
- Labels `service=workforce env=<env> managed_by=terraform`.

The per-spec HRBP fan-out queue (`workforce-hrbp-fanout-${env}`) and the
enqueuer IAM binding granting this module's SA `roles/cloudtasks.enqueuer`
are declared one level up in `projects/platform-control/main.tf` because
the queue is project-level infrastructure, not module-private.

See `variables.tf` for inputs.
