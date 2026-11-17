# Connector Service

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

Owns the connector catalogue and everything that makes a connection work: OAuth
flows, credential custody, the per-vendor clients, MCP sidecars, the capability
registry, and a polling scheduler that pushes new connector records to the tenant
runtime as Pub/Sub events.

It owns its own database. Connector ids live here and nowhere else, so other
services reference them without a foreign key.

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

`npm run test:integration` reaches real vendors and needs credentials.

## Configuration

Copy `.env.example`. Three groups matter:

- **Its own database** and the Pub/Sub topics it publishes to.
- **A managed-auth provider key**, optional. With one, roughly half the catalogue
  works without you registering OAuth applications, because the provider holds
  those client credentials. Run `npm run composio:bootstrap-toolkit` once
  afterwards to create the resources in your own organisation and write their
  resolved ids; the catalogue prefers that file over the values baked into it.
- **Direct OAuth client credentials** for the vendors you want that are not
  covered by managed auth, as `<VENDOR>_CLIENT_ID` and `<VENDOR>_CLIENT_SECRET`.
  [docs/OAUTH_CREDENTIALS.md](docs/OAUTH_CREDENTIALS.md) lists all of them with
  the developer console to register each one in.

API-key connectors need nothing from you — the user supplies their own key.

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit
- [DEPLOYMENT.md](DEPLOYMENT.md) — standing it up
- [docs/CONNECTORS.md](docs/CONNECTORS.md) — the catalogue and its auth models
- [docs/ADDING_A_CONNECTOR.md](docs/ADDING_A_CONNECTOR.md) — adding one
- [docs/OAUTH_CREDENTIALS.md](docs/OAUTH_CREDENTIALS.md) — the OAuth applications to register
