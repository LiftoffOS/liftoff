# Harvest Service

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

Turns raw third-party content into structured knowledge. It subscribes to
connector polling events from Pub/Sub, classifies what arrives, and persists the
part worth keeping.

It is the boundary between the connector ecosystem and the agents that use the
result. It does not manage connectors, hold credentials or execute anything — it
classifies and stores.

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

Copy `.env.example`. It needs its own database URL, the Pub/Sub subscription it
reads from, and an embedding provider key for the classification step.

## Further reading

- [docs/operations.md](docs/operations.md) — deploys and the subscription setup
