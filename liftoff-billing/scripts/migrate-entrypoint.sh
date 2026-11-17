#!/bin/sh
# Runs node-pg-migrate against the `billing` database. Invoked by
# the billing-migrate Cloud Run Job (terraform/modules/billing/).
# Cloud SQL socket is mounted at /cloudsql/<connection-name>/.s.PGSQL.5432.
# All PG* env vars are set explicitly to avoid URL-parse ambiguity with unix sockets.
set -eu
export PGHOST="/cloudsql/${DB_INSTANCE_CONNECTION_NAME}"
export PGUSER="billing_migrate"
export PGPASSWORD="${DB_MIGRATE_PASSWORD}"
export PGDATABASE="billing"
export PGPORT="5432"
exec ./node_modules/.bin/node-pg-migrate \
  --migrations-dir ./migrations \
  up
