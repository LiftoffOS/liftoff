# Custom domain for the anchor-webhook-receiver Cloud Run service.
#
# Before this hostname existed, the Anchor → tenant-runtime delivery URL was
# the auto-generated Cloud Run hostname
# (anchor-webhook-receiver-<projhash>-uw.a.run.app), which is brittle:
# the hash changes if the project moves, the Cloud Run URL convention
# can change underneath us, and `--set-env-vars` in connector-service's
# cloudbuild.yaml silently wipes the registrar's ANCHOR_WEBHOOK_RECEIVER_URL
# on every deploy unless every reachable code path agrees on the value.
#
# With a custom domain, Anchor stores `https://anchor-webhooks.example.com/anchor`
# (prod) / `…anchor-webhooks-dev.example.com/anchor` (dev) once. After
# that, any change to the underlying Cloud Run service — rename, region
# move, blue/green — is invisible to Anchor; the receiver just answers
# at a hostname we own.
#
# The hostname terminates on the platform-control load balancer
# (platform-control/public_lb.tf), which reaches the receiver in this project
# through an internet NEG by its deterministic Cloud Run URL
# (anchor-webhook-receiver-<project number>.<region>.run.app); the DNS record
# lives there too. No load balancer exists in this project on purpose: a
# project's first forwarding rule starts its flat minimum charge. The Cloud
# Run domain mapping that first carried the hostname was removed once it cut
# over (a mapping negotiates TLS 1.0 and cannot carry an SSL policy). The
# receiver itself is created by tenant-runtime's cloudbuild.yaml
# (deploy-anchor-webhook-receiver step), not by Terraform, and its ingress
# must stay open: traffic from an internet NEG arrives as external.

locals {
  anchor_webhook_subdomain = var.environment == "prod" ? "anchor-webhooks" : "anchor-webhooks-${var.environment}"
  anchor_webhook_hostname  = "${local.anchor_webhook_subdomain}.example.com"
}

output "anchor_webhook_receiver_url" {
  value       = var.tenant_runtime_deployed ? "https://${local.anchor_webhook_hostname}" : null
  description = "Stable custom-domain URL for the anchor-webhook-receiver. Used as WEBHOOKS_BASE_URL on connector-service so Anchor webhook registration writes a URL that survives Cloud Run rename/migration."
}
