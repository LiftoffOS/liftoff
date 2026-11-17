# Contributing

Pull requests and forks are both welcome. If you are changing something
substantial, opening an issue first saves everyone the rework.

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of
Origin](https://developercertificate.org/). Sign off each commit:

```sh
git commit -s -m "your message"
```

That adds a `Signed-off-by` line and asserts you wrote the patch or have the
right to submit it. There is no contributor licence agreement.

## Working in the repository

It is one npm workspace. Install once at the root, and build in dependency
order:

```sh
npm ci
python3 scripts/build-all.py
```

`npm run build --workspaces` is the wrong command — npm runs members in listing
order, so services compile before the packages they import. The README explains
this at more length.

Each service has its own tests, which run from its own directory:

```sh
cd liftoff-platform-backend
npm test
npm run lint
npm run typecheck
```

Several suites need a Postgres instance. Where they do, the service's own
documentation says so.

## Things that will bite you

- **Migrations are append-only.** `node-pg-migrate` records filenames, so
  editing a migration that has already been applied runs in no database that
  already has it, while a from-scratch rebuild gets the new text. The two then
  disagree permanently. Fix forward with a new idempotent migration.
- **Every checkout needs its own `node_modules`.** Do not symlink one at
  another; an install in either silently rewrites what both compile against.
- **Tenant-scoped tables are protected by row-level security.** Queries go
  through the scope wrappers rather than a raw pool. Lint enforces it, and the
  reason is in `liftoff-platform-backend/docs/rls.md`.
- **`dist/` is generated and gitignored.** In an older checkout a stale one
  survives an install and nothing rebuilds it, which surfaces as a type error
  naming a property on your own code. Rebuild the packages before believing it.

## Style

Follow what is already in the file you are editing. Lint and typecheck both pass
on `main`; keep them passing.
