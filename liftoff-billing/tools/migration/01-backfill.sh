#!/usr/bin/env bash
# Phase 1f step 2 — initial backfill.
#
# Dumps billing_legacy_schema.* from liftoff_control and loads into the
# new `billing` database on the same Cloud SQL instance. Run under the
# `billing_migrate` role (the only role with DDL on the target).
#
# Replication starts at the LSN captured here; the captured LSN is
# printed so the operator can feed it to `02-enable-replication.sh`.

set -euo pipefail

: "${CONTROL_PLANE_CONN:=?set CONTROL_PLANE_CONN to the liftoff_control connection string}"
: "${BILLING_CONN:=?set BILLING_CONN to the billing connection string}"

echo "[backfill] capturing start LSN from control-plane..."
START_LSN=$(psql -X -Atc "SELECT pg_current_wal_lsn()" "$CONTROL_PLANE_CONN")
echo "[backfill] start LSN = $START_LSN"
echo "$START_LSN" > /tmp/billing-cutover-start-lsn.txt

echo "[backfill] dumping billing_legacy_schema..."
pg_dump -n billing_legacy_schema --data-only --no-owner --no-acl "$CONTROL_PLANE_CONN" \
  | sed 's/billing_legacy_schema\./public./g' \
  | psql -X "$BILLING_CONN"

echo "[backfill] post-backfill checksums:"
for table in subscriptions subscription_items plans plan_features invoices invoice_line_items meter_events payment_methods stripe_webhook_events; do
  src_count=$(psql -X -Atc "SELECT COUNT(*) FROM billing_legacy_schema.$table" "$CONTROL_PLANE_CONN")
  dst_count=$(psql -X -Atc "SELECT COUNT(*) FROM $table" "$BILLING_CONN")
  if [ "$src_count" != "$dst_count" ]; then
    echo "[backfill] MISMATCH on $table: src=$src_count dst=$dst_count"
    exit 1
  fi
  echo "[backfill]   $table: $src_count rows"
done

echo "[backfill] done. Feed the captured LSN into 02-enable-replication.sh:"
echo "  START_LSN=$(cat /tmp/billing-cutover-start-lsn.txt) ./02-enable-replication.sh"
