#!/usr/bin/env bash
# Phase 0i — each service's migrations baseline MUST include
# `CREATE TABLE ... PARTITION OF` statements for the next 3 months
# of audit/usage-log partitions. Catches drift where a Cloud Scheduler
# gap would leave the +18-month window short.
#
# Usage:
#   validate-partition-baseline.sh <migrations-dir> <partition-pattern>
#
# Example:
#   validate-partition-baseline.sh migrations 'billing_audit_log_y%Y_m%m'
set -euo pipefail

DIR="${1:?migrations dir required}"
PATTERN="${2:?partition pattern required (e.g. billing_audit_log_y%Y_m%m)}"

FAIL=0

for i in 1 2 3; do
  # Compute YYYY-MM for today + i months
  YEAR_MONTH=$(python3 -c "
from datetime import date
from dateutil.relativedelta import relativedelta
d = date.today() + relativedelta(months=$i)
print(d.strftime('%Y-%m'))
" 2>/dev/null || date -u -v+${i}m '+%Y-%m')

  IFS='-' read -r Y M <<< "$YEAR_MONTH"
  EXPECTED=$(echo "$PATTERN" | sed "s/%Y/$Y/g; s/%m/$M/g")

  if grep -rq "$EXPECTED" "$DIR" 2>/dev/null; then
    continue
  fi
  echo "[validate-partition-baseline] FAIL: $DIR missing '$EXPECTED' (month +$i from today)"
  FAIL=$((FAIL + 1))
done

if [ "$FAIL" -gt 0 ]; then
  echo "[validate-partition-baseline] $FAIL missing partition(s). Run \`npm run provision-partitions\` or update the next migration."
  exit 1
fi
echo "[validate-partition-baseline] OK — next 3 months of partitions present under $DIR"
