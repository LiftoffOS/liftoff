# developer-proxy

Terraform module for the `liftoff-developer-proxy` Cloud Run deployment (Phase 1.5
of platform-backend decomposition).

## What it provisions

- Service account `developer-proxy-${env}`.
- Database `developer_proxy` on the shared `control-plane-pg` instance (plan 0d).
- Role triad `developer_proxy_migrate` / `developer_proxy_app` / `developer_proxy_readonly` (plan 0g).
- KMS key `developer-proxy-key` in `keyring-${env}` (plan 0l).
- Secret Manager IAM scoped via IAM Condition to `developer-proxy-*` secrets (plan 0d).
- **Cloud Run service** with `min-instances=1` (plan 0d exception — SSE
  sessions are long-lived and can't survive cold starts), `ingress=internal`,
  `--no-allow-unauthenticated`, `terminationGracePeriodSeconds=35`.
  VPC connector egress `ALL_TRAFFIC` so outbound vendor-API calls are routed
  through the VPC for stable IP + vendor allowlisting.
- Cloud Build trigger, Binary Authorization attestor.
- Cloud Monitoring dashboard, SLOs (proxy overhead < 5ms, SSE error rate
  < 0.1%), burn-rate alerts at 2%/5%/10%.
- Labels `service=developer-proxy env=<env> managed_by=terraform`.

## Inputs

Same shape as the `billing` module. Key deltas:

| Name | Default |
|------|---------|
| `min_instances` | `1` — plan 0d requirement |
| `max_instances` | `20` |

See `variables.tf` for the full list.

## Outputs

`service_account_email`, `service_url`, `db_name`, `kms_key_id`, `enabled`.
