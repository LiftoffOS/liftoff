# Tenant Runtime

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

Where agents actually execute. It takes a configured agent and runs it: calls
the model, dispatches tools, keeps the workspace isolated, and records what
happened.

Node and TypeScript, deployed to Cloud Run with its own Postgres database,
separate from the control plane's.

## What it owns

- **Agent execution** — the agent lifecycle, the turn loop, and the engine
  adapters that drive each vendor's SDK or CLI.
- **Interactive chat** — streaming turns, turn locks, and the terminal frame
  every stream ends with.
- **The tool gateway** — the safety boundary. Every tool call passes through it,
  which is where governance, approval gates and cost attribution attach.
- **Workflow coordination** — multi-step work, task dependencies, resume from
  checkpoints, and idempotent step tracking with a dead-letter queue.
- **Memory** — vector memory over layers, with retrieval at turn time.
- **Per-invocation workspace isolation** — a fresh working directory and `HOME`
  per run, so one invocation cannot read another's files.
- **Browser sessions** — driving a real browser for agents that need one.
- **Webhook ingest** — per-tenant inbound endpoints, normalised into events.

It reads entitlements from the control plane and caches them briefly; it never
computes its own view of whether a workspace may spend.

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
```

There are also `test:integration`, `test:fault-injection` and `test:browser`,
which need a database or a browser and are not part of the unit run.

Two things worth knowing when a suite fails unexpectedly:

- **`dist/` is generated and gitignored.** In an existing checkout a stale one
  survives an install and nothing rebuilds it, which surfaces as a failure in
  code nobody touched. Rebuild the workspace packages before believing it.
- **`npm run check:deps`** runs before test, typecheck and build, and fails when
  the installed tree does not describe this checkout. Every checkout needs its
  own `node_modules`.

## Configuration

Copy `.env.example` and fill it in. Hostnames are `example.com` placeholders you
are expected to replace, and the control-plane URL is one of them — the runtime
cannot do anything useful until it points at your own deployment.

## Further reading

Service-specific notes are in [docs/](docs/). The system-wide architecture lives
in the control plane's
[docs/ARCHITECTURE.md](../liftoff-platform-backend/docs/ARCHITECTURE.md).
