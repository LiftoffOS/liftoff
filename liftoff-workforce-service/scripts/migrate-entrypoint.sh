#!/bin/sh
# Runs node-pg-migrate up against the workforce database via Cloud SQL Unix socket.
# Cloud SQL socket is mounted at /cloudsql/<connection-name>/.s.PGSQL.5432.
set -eu

DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@/${DB_NAME}?host=/cloudsql/${CLOUD_SQL_CONNECTION_NAME}"
export DATABASE_URL

# Wait for the Cloud SQL Auth Proxy socket to appear (max 30 s)
SOCKET_DIR="/cloudsql/${CLOUD_SQL_CONNECTION_NAME}"
echo "Waiting for Cloud SQL proxy at ${SOCKET_DIR}..."
ATTEMPTS=0
until [ -S "${SOCKET_DIR}/.s.PGSQL.5432" ] || [ $ATTEMPTS -ge 30 ]; do
  sleep 1
  ATTEMPTS=$((ATTEMPTS + 1))
done

if [ $ATTEMPTS -ge 30 ]; then
  echo "ERROR: Cloud SQL proxy socket not found after 30 seconds" >&2
  exit 1
fi

echo "Cloud SQL proxy ready. Applying role grants..."
psql "${DATABASE_URL}" -f /app/scripts/setup_grants.sql

echo "Running migrations..."
exec npx node-pg-migrate up \
  --migrations-dir=migrations \
  --no-check-order
