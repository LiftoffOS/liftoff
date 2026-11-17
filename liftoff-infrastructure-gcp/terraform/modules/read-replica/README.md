# read-replica

One read replica on `control-plane-pg-${env}` per plan 0d. Consumed by
**billing** (Stripe reconciliation scans). Writes continue to the primary.

Outputs `connection_name` and `private_ip` for downstream service modules to
mount as a secondary Cloud SQL instance.
