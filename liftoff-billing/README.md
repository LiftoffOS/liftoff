# Billing Service

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

Owns every Stripe interaction: subscriptions and their lifecycle, invoice
persistence, the outbox publisher, and the per-tenant prepaid wallet. The control
plane has no direct Stripe dependency — it talks to this service over
HMAC-authenticated internal endpoints for rates, consumption and suspension
state.

A deployment with no payment provider does not need this service running. The
control plane selects a no-op billing provider when `STRIPE_SECRET_KEY` is
absent, and runs with charging switched off rather than broken.

## Running it

Install at the repository root — it is one npm workspace — then from here:

```sh
npm run migrate
npm run dev       # watch mode
npm start         # run the built output
```

## Tests and checks

```sh
npm test
npm run lint
npm run typecheck
```

## Configuration

Copy `.env.example`. It needs your own Stripe secret and webhook signing secret,
the shared HMAC secret it uses to talk to the control plane, and its own database
URL.

## Billing modes

A tenant is either subscription-billed or prepaid, stored in
`billing_controls.billing_mode` and **set once at provision time**. There is no
in-place switch: changing it means cancelling and re-provisioning. The endpoints
that do so are in `docs/operations.md`.

## Further reading

- [docs/operations.md](docs/operations.md) — deploys, migrations, the replace-subscription flow
- [docs/backend-services.md](docs/backend-services.md) — how this fits with the other services
