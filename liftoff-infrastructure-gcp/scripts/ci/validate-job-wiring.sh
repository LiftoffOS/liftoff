#!/usr/bin/env bash
# Every scheduled Cloud Run Job must be able to start and to reach its database.
#
# A scheduler can sit in a failed state while still reporting ENABLED, because
# a Cloud Scheduler failure lives in a status field nothing surfaces. The
# causes this checks for are structural and visible in the .tf files:
#
#   1. a scheduler firing at a Cloud Run Job whose IAM policy is empty, so
#      every attempt returns PERMISSION_DENIED and the job never runs once
#   2. a job given DB connection details but no Cloud SQL volume, or a volume
#      but no VPC egress — the control-plane instance is private IP only and
#      needs both, and the job dies on a dial timeout or ENOENT
#   3. a scheduler pointing at an HTTP path under a bare /internal prefix,
#      which platform-backend has never served — it mounts /api/internal
#
# Checked per RESOURCE, not per file. A file-level grep passes as soon as any
# one job in it carries the wiring, so one unwired job can hide in a file whose
# other jobs are fine.
#
# macOS ships bash 3.2; no associative arrays, no mapfile.
set -uo pipefail

ROOT="${1:-terraform}"
FAIL=0
note() { echo "[validate-job-wiring] $*"; }

# Splits a .tf file into `google_cloud_run_v2_job` blocks and prints each as
# "file:name:<body>" with newlines flattened, so per-resource greps are simple.
extract_jobs() {
  awk '
    /^resource[[:space:]]+"google_cloud_run_v2_job"/ {
      inres = 1; depth = 0; body = ""; 
      name = $3; gsub(/"/, "", name);
    }
    inres {
      body = body " " $0
      n = gsub(/\{/, "{"); depth += n
      m = gsub(/\}/, "}"); depth -= m
      if (depth <= 0 && body ~ /\{/) {
        printf "%s\t%s\t%s\n", FILENAME, name, body
        inres = 0
      }
    }
  ' "$1"
}

for f in $(grep -rl "google_cloud_run_v2_job" "$ROOT" --include=*.tf 2>/dev/null); do
  extract_jobs "$f" | while IFS=$'\t' read -r file name body; do
    case "$body" in
      *DB_INSTANCE_CONNECTION_NAME*|*CLOUD_SQL_CONNECTION_NAME*) ;;
      *) continue ;;
    esac
    case "$body" in
      *cloud_sql_instance*) ;;
      *) echo "MISS_VOLUME $file $name" ;;
    esac
    case "$body" in
      *vpc_access*) ;;
      *) echo "MISS_VPC $file $name" ;;
    esac
  done
done > /tmp/job_wiring_findings.$$ 2>/dev/null

while read -r kind file name; do
  [ -z "${kind:-}" ] && continue
  if [ "$kind" = "MISS_VOLUME" ]; then
    note "FAIL: $file resource \"$name\" takes DB connection details with no cloud_sql_instance volume."
    note "      It will die on: connect ENOENT /cloudsql/<conn>/.s.PGSQL.5432"
  else
    note "FAIL: $file resource \"$name\" mounts Cloud SQL with no vpc_access."
    note "      The instance is private IP only; the socket alone is not a route to it."
  fi
  FAIL=$((FAIL + 1))
done < /tmp/job_wiring_findings.$$
rm -f /tmp/job_wiring_findings.$$

# ── A scheduler that runs a Cloud Run Job needs an invoker grant ────────────
# Either the per-job binding or a project-level roles/run.invoker, which
# restore-drill uses. Accepting both matters: a check that flags a working
# configuration teaches people to ignore it.
for f in $(grep -rl "run.googleapis.com/v1/namespaces" "$ROOT" --include=*.tf 2>/dev/null); do
  dir="$(dirname "$f")"
  if ! grep -rqs -E "google_cloud_run_v2_job_iam_member|roles/run\.invoker" "$dir"/*.tf; then
    note "FAIL: $f schedules a Cloud Run Job and $dir grants run.invoker nowhere."
    note "      The scheduler will report ENABLED and return PERMISSION_DENIED on every fire."
    FAIL=$((FAIL + 1))
  fi
done

# ── No scheduler may target a bare /internal path ──────────────────────────
bad_uris=$(grep -rn 'uri *= *"\${local.platform_backend_public_url}/internal/' "$ROOT" --include=*.tf 2>/dev/null || true)
if [ -n "$bad_uris" ]; then
  note "FAIL: scheduler target(s) under a bare /internal prefix — the service mounts /api/internal:"
  echo "$bad_uris" | sed 's/^/            /'
  FAIL=$((FAIL + 1))
fi

if [ "$FAIL" -gt 0 ]; then
  note "$FAIL problem(s). Each one is invisible at runtime except in a scheduler status field."
  exit 1
fi

note "PASS: scheduled jobs can be invoked and can reach their database."
