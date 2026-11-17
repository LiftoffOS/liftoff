# Platform Backend

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

The control plane. It answers "who are you, what can you do, and what are you
allowed to use", and it owns the database that most of the system reads from.

Node and TypeScript, deployed to Cloud Run against Cloud SQL (Postgres, private
IP only).

## What it owns

- **Identity and tenancy** — accounts, passkeys, tenants, members and roles,
  provisioning, invitations and sign-up approval.
- **Commercial** — plans, subscriptions, meters, entitlements, overage rules and
  cost attribution. Stripe sits behind a seam, so a deployment with no payment
  provider runs with billing switched off rather than broken.
- **Agents** — agent records, templates, oversight and the human-in-the-loop
  gates, audit logs, and the distillation that turns a described job into a
  configured agent.
- **Registries** — approved models and their prices and context windows,
  versioned prompts, and feature flags.
- **Knowledge and insights** — embeddings, the knowledge library, and the cost
  and activity reporting the dashboard reads.
- **The MCP door** — an MCP server with OAuth, so coding tools can work against
  a workspace directly.
- **Workspace export** — one synchronous archive of a workspace, for the people
  whose data it is.

It also proxies to the services that own their own data: connectors, billing,
governance, workforce and the company endpoints.

## Running it

Install once at the root of the repository, not here — it is one npm workspace:

```sh
npm ci                        # at the repository root
python3 scripts/build-all.py  # builds every member in dependency order
```

Then, from this directory:

```sh
npm run migrate   # apply migrations
npm run dev       # watch mode
npm start         # run the built output
```

## Tests and checks

```sh
npm test          # unit suite
npm run lint      # eslint, plus the local rules in eslint-rules/
npm run typecheck
npm run ci-fences # the shell-script invariant checks
```

`npm run test:integration` needs a Postgres instance. `npm run check:deps` runs
before test, typecheck and build, and fails when the installed dependency tree
does not describe this checkout — **every checkout needs its own
`node_modules`**, never a symlink to another's.

## Configuration

Copy `.env.example` and fill it in. Nothing has a working default that reaches a
real service; hostnames are `example.com` placeholders you are expected to
replace.

At least one model provider key is required — Anthropic, OpenAI, Google (Vertex)
or xAI — or no turn can start. Keys resolve from the environment first, then from
a Secret Manager secret of the same name in your own project.

## Database

Migrations are in `migrations/`, applied with `node-pg-migrate` by `npm run
migrate`. They are **append-only**: `node-pg-migrate` records filenames, so
editing one that has already run applies to no database that already has it,
while a rebuild from scratch gets the new text, and the two disagree
permanently. Fix forward with a new idempotent migration.

Tenant-scoped tables are protected by row-level security. Queries go through the
scope wrappers rather than a raw pool, and lint enforces it.
`scripts/ci/prepare-verify-db.cjs` creates the Postgres roles the migrations
grant to, which a bare instance does not have.

## Further reading

| Topic | Where |
|---|---|
| Architecture and data flows | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Deploys, projects, migrations | [docs/operations.md](docs/operations.md) |
| Common failures | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| Admin API | [docs/admin-api.md](docs/admin-api.md) |
| Row-level security | [docs/rls.md](docs/rls.md) |
| Metering and cost | [docs/billing-meter.md](docs/billing-meter.md) |
| The other services | [docs/backend-services.md](docs/backend-services.md) |
