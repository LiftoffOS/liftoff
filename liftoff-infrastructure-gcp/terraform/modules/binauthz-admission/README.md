# binauthz-admission

Project-level Binary Authorization admission policy that closes Phase 0e
gap 3 — the plan requires every Liftoff service to deploy only images
signed by that service's Cloud Build pipeline.

## Instantiation

Instantiate once per `YOUR_GCP_PROJECT` project after
all per-service attestors are created. Pass the attestor names as a
list:

```hcl
module "binauthz_admission" {
  source      = "../../modules/binauthz-admission"
  project_id  = var.project_id
  environment = var.environment
  attestor_names = [
    module.billing.attestor_name,
    module.developer_proxy.attestor_name,
    module.workforce_service.attestor_name,
    module.platform_backend.attestor_name,
    module.connector_service.attestor_name,
    module.governance_engine.attestor_name,
    module.tenant_runtime.attestor_name,
  ]
}
```

The existing single-attestor policy from `modules/binary-authorization/`
is superseded by this module; remove the old `google_binary_authorization_policy`
resource from that module's `main.tf` once this rolls out, OR delete
the invocation in `platform-control/main.tf`.

## Enforcement mode

- **prod:** `ENFORCED_BLOCK_AND_AUDIT_LOG` — unsigned / incorrectly-
  signed images refused at admission.
- **dev:** `DRYRUN_AUDIT_LOG_ONLY` — policy violations logged but
  deployment still proceeds. This lets the team iterate on attestor
  wiring without breaking dev CI.

## Rollout note

Flip this on AFTER every service's Cloud Build pipeline is producing
valid per-service attestations in both environments. Otherwise a dev
image built without attestation wiring will fail in prod the moment this
flips to enforce. Every service (including billing, developer-proxy and
workforce-service) needs to be producing attestations first.
