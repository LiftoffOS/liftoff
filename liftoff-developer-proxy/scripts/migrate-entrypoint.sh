#!/bin/sh
set -eu
export PGHOST="/cloudsql/${DB_INSTANCE_CONNECTION_NAME}"
export PGUSER="developer_proxy_migrate"
export PGPASSWORD="${DB_MIGRATE_PASSWORD}"
export PGDATABASE="developer_proxy"
export PGPORT="5432"
exec ./node_modules/.bin/node-pg-migrate \
  --migrations-dir ./migrations \
  up
