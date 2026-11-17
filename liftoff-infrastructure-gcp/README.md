# liftoff-infrastructure-gcp

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

Terraform modules for running a multi-tenant agent platform on Google Cloud.

Each module provisions one capability, takes the target project as a variable, and
has no knowledge of any particular deployment. They are the modules the rest of
Liftoff deploys onto, so the deployment is something you can read rather than
guess at.

## What is here

**Compute and data**
| Module | What it provisions |
|---|---|
| `cloud-run` | Cloud Run services with per-service instance and connection-pool budgets, so that `max_instances x db_pool_size` cannot exceed what Cloud SQL will accept |
| `cloud-run-jobs`, `cloud-tasks` | Jobs and queues for scheduled and deferred work |
| `cloud-run-lb` | External load balancer in front of Cloud Run, with managed certificates |
| `cloud-sql` | Postgres with private IP only |
| `read-replica` | A read replica for read-heavy and reporting traffic |
| `pgbouncer` | A shared transaction-mode pooler on a managed instance group. The header comment explains why a shared pooler and not a sidecar: a sidecar per Cloud Run instance opens its own backends and spends the pool budget it was meant to protect |

**Isolation and supply chain**
| Module | What it provisions |
|---|---|
| `sandbox-egress-proxy` | An Envoy sidecar that intercepts every outbound call from a sandbox container at the network layer, whatever HTTP client the code inside chose. It logs each request, takes a preflight read before a write verb reaches a known vendor endpoint, and emits structured audit events. This is how code written by an AI team becomes auditable without trusting the code to report on itself |
| `binary-authorization`, `binauthz-admission` | Per-service attestors, so that an image built for one service cannot be admitted to another |
| `vpc-service-controls` | A service perimeter, to bound exfiltration |
| `workload-identity-federation` | Keyless CI authentication |
| `kms`, `secret-manager` | Keys and secrets, with per-service separation |

**Audit and recovery**
| Module | What it provisions |
|---|---|
| `audit-anchor` | An object-locked bucket with a seven-year retention policy and append-only IAM, keyed separately from every service key, for tamper-evident log anchoring |
| `restore-drill` | Automation for a periodic restore drill. A backup nobody has restored is a hypothesis |
| `data-export-orchestrator` | A job that fans out to each service to assemble a data-subject export, and writes a receipt to a retained bucket |
| `audit`, `logging`, `bigquery-sink` | Log sinks and analytics datasets |
| `observability`, `tracing`, `alert-policies`, `workflow-alerting` | Dashboards, traces and alert policies |
| `pubsub`, `pubsub-events` | Topics and dead-letter topics, owned by the producing service |
| `iam` | Role bindings |

**Plan-time validators** (`scripts/ci/`)

Five checks that read a Terraform plan and fail the build rather than leaving a
problem for a reviewer to notice:

- `validate-secret-accessor.sh`: a service may read only its own secrets.
- `validate-no-cloudsqlsuperuser.sh`: no application role holds superuser.
- `validate-kms-key-ref.sh`: every encrypted resource names a key, and the key exists.
- `validate-job-wiring.sh`: a scheduler target resolves to a job that exists.
- `validate-partition-baseline.sh`: a range-partitioned table has a default partition.

The last one is there because a partitioned table whose partition list runs out does
not fail loudly. Postgres raises a check violation, the application catches it, the
request succeeds, and the rows are gone.

`docs/invariants.md` states the properties these checks defend.

## What is not here

This is a subset, and the omissions are deliberate rather than accidental:

- **The environment and project definitions.** The root configurations that compose
  these modules into Liftoff OS's own projects describe one live estate: its IAM
  bindings, VPC peering, private service-connect endpoints and scheduler targets.
  Removing the identifiers would leave the topology, which is the half that helps an
  attacker and helps no one else.
- **Per-service wiring.** Which database a given service holds, which service account
  it runs as, and which jobs it owns is a map of one deployment rather than a module
  anyone else can call.
- **The response runbooks.** Break-glass access, disaster recovery and restore
  procedures are the playbook for a specific estate.

A module is not usable as a complete deployment on its own. Composing these into
something that runs is your root configuration to write, and the variable
descriptions are the contract.

## Using a module

```hcl
module "sandbox_egress_proxy" {
  source = "./terraform/modules/sandbox-egress-proxy"

  project_id              = var.project_id
  environment             = var.environment
  vendor_domain_allowlist = ["api.example-vendor.com"]
}
```

Terraform 1.5 or later, and the `google` and `google-beta` providers. Each module
declares its own version constraints.

## Licence

Business Source License 1.1. See [LICENSE](LICENSE).
