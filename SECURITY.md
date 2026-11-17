# Security

To report a vulnerability, open a private report on the repository's Security
tab. If the issue is in a dependency rather than in this code, report it
upstream, where the maintainers of that package can act on it.

## If you are running this

You are the operator: your cloud project, your credentials, your data. Four
things are load-bearing and easy to skip past.

- **Replace every placeholder host.** Hostnames in this tree point at
  `example.com`, a reserved documentation domain that resolves nowhere. They are
  placeholders rather than empty values, so nothing fails loudly to tell you one
  was missed — a webhook address or a control-plane URL left as shipped simply
  never reaches anything. Search the tree for `example.com` before you go near
  production.
- **Generate your own secrets.** Anything shipped as a default is public by
  definition. The signing and service values — `SIGNUP_APPROVAL_SECRET`,
  `UNSUBSCRIBE_SECRET`, the inter-service tokens — must be replaced before the
  deployment faces anyone.
- **Tenant isolation is enforced in the database,** by row-level security on
  roughly a hundred tables, not only in application code. If you add a
  tenant-scoped table, add its policy; the lint rules and the migration tests
  will tell you when you have not.
- **Pin and scan your dependencies.** The lockfile is a point in time and starts
  ageing the day you clone it. Run your own vulnerability scanning and upgrade on
  your own schedule.

The deployment is private by default: Cloud SQL is private IP only and the
services sit behind your own ingress. Opening any of that up is a decision you
make, not one the Terraform makes for you.
