# Operations — deploy, promotion, GCP resources

> The deploy rule is INV-BILL-006 in invariants.md. 

## Deployment

**Never run `gcloud builds submit` manually.** Deploys are split across two branches:

- **`main` → dev.** Trigger `billing-dev` in `YOUR_CI_PROJECT_STAGING` deploys `billing` in
  `YOUR_CONTROL_PROJECT_STAGING`.
- **`release` → prod.** Trigger `billing-prod` in `YOUR_CI_PROJECT` deploys
  `billing` in `YOUR_CONTROL_PROJECT`.

Both projects use the same root `cloudbuild.yaml`. Promote to prod by fast-forwarding
`release` to verified `main`:

```bash
git checkout release
git merge --ff-only origin/main
git push origin release
```

Pushes to `main` must result in a healthy dev Cloud Run revision; monitor the dev Cloud Build
to completion. Promotion to prod is a separate, deliberate step; monitor the prod Cloud Build
the same way. Never force-push `main` or `release`.

## GCP resources

| Resource | Location |
|---|---|
| Cloud Run service (internal API) | `billing` in `YOUR_GCP_PROJECT<env>` |
| Cloud Run service (Stripe ingress) | `billing-stripe-webhook` in `YOUR_GCP_PROJECT<env>` |
| Cloud Run migrate job | `billing-migrate-<env>` in `YOUR_GCP_PROJECT<env>` |
| Cloud SQL instance | `control-plane-pg-<env>` in `YOUR_GCP_PROJECT<env>` |
| Docker images | `us-west1-docker.pkg.dev/YOUR_GCP_PROJECT<env>/YOUR_GCP_PROJECT<env>/billing` |
