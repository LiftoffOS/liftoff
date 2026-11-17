# Governance Engine

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

The single policy enforcement point. Every tool call in the platform runs through
it before it executes and again after it completes.

It owns human-in-the-loop approvals, admission decisions (rate limits, kill
switches, allowlists), the action ledger, the usage ledger and the audit trail.
Putting all of that in one service is the point: a second place that decides
whether an action may proceed is a second place that can disagree.

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

Copy `.env.example`. It needs its own database URL and the shared secrets it uses
to authenticate calls from the control plane and the tenant runtime.

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — the enforcement path and the ledgers
- docs/ — operational notes
