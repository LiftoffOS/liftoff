#!/usr/bin/env bash
# Phase 1f step 3 — enable logical replication from
# liftoff_control.billing_legacy_schema → billing.public.
#
# Requires START_LSN from 01-backfill.sh so replication begins at the
# captured snapshot boundary.

set -euo pipefail

: "${CONTROL_PLANE_CONN:=?set CONTROL_PLANE_CONN}"
: "${BILLING_CONN:=?set BILLING_CONN}"
: "${START_LSN:=?set START_LSN from 01-backfill.sh}"
: "${ENV:=dev}"

PUB_NAME="billing_cutover_pub_${ENV}"
SUB_NAME="billing_cutover_${ENV}"
SLOT_NAME="billing_cutover_${ENV}"

echo "[replication] creating publication on control-plane..."
psql -X "$CONTROL_PLANE_CONN" <<SQL
CREATE PUBLICATION ${PUB_NAME} FOR TABLE
  billing_legacy_schema.subscriptions,
  billing_legacy_schema.subscription_items,
  billing_legacy_schema.plans,
  billing_legacy_schema.plan_features,
  billing_legacy_schema.invoices,
  billing_legacy_schema.invoice_line_items,
  billing_legacy_schema.meter_events,
  billing_legacy_schema.payment_methods,
  billing_legacy_schema.stripe_webhook_events;
SQL

echo "[replication] creating subscription on billing..."
psql -X "$BILLING_CONN" <<SQL
CREATE SUBSCRIPTION ${SUB_NAME}
  CONNECTION '$(printf '%s' "$CONTROL_PLANE_CONN")'
  PUBLICATION ${PUB_NAME}
  WITH (
    copy_data = false,
    create_slot = true,
    slot_name = '${SLOT_NAME}',
    enabled = true
  );
SQL

echo "[replication] started at LSN ${START_LSN}."
echo "[replication] monitor lag via:"
echo "  SELECT confirmed_flush_lsn, pg_current_wal_lsn() - confirmed_flush_lsn AS lag FROM pg_replication_slots WHERE slot_name='${SLOT_NAME}';"
