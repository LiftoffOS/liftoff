#!/usr/bin/env bash
#
# Seed Firebase Remote Config from remoteconfig.template.json WITHOUT clobbering
# console-managed values.
#
# The Firebase **console is the source of truth** for flag VALUES. This script
# only CREATES parameters that do not already exist in the live config (e.g. a
# brand-new flag introduced in code). Existing parameters — including any value
# an operator set in the Firebase UI — are preserved untouched. When there is
# nothing new to add, the live config is left completely alone (no PUT happens).
#
# This replaces the previous deploy behavior, which force-PUT the whole template
# (If-Match: *) on every deploy and therefore reverted any console edit.
#
# Invoked from cloudbuild.yaml. Impersonates the Firebase admin SA because
# Remote Config's auth layer does not honor plain GCP IAM bindings; the Cloud
# Build SA holds roles/iam.serviceAccountTokenCreator on that SA.
set -uo pipefail

PROJECT="YOUR_WEB_PROJECT"
ADMIN_SA="firebase-adminsdk-fbsvc@${PROJECT}.iam.gserviceaccount.com"
RC_URL="https://firebaseremoteconfig.googleapis.com/v1/projects/${PROJECT}/remoteConfig"
TEMPLATE="remoteconfig.template.json"

ACCESS_TOKEN="$(gcloud auth print-access-token --impersonate-service-account="${ADMIN_SA}")"
if [ -z "${ACCESS_TOKEN}" ]; then
  echo "WARNING: could not mint admin access token; skipping Remote Config seed."
  exit 0
fi

# 1. Read the live config (the source of truth) and capture its ETag if present.
GET_CODE="$(curl -s -D /tmp/rc_headers.txt -o /tmp/rc_live.json -w '%{http_code}' \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" "${RC_URL}")"
if [ "${GET_CODE}" -lt 200 ] || [ "${GET_CODE}" -ge 300 ]; then
  echo "WARNING: could not read live Remote Config (HTTP ${GET_CODE}); skipping seed."
  cat /tmp/rc_live.json || true
  exit 0
fi
ETAG="$(grep -i '^etag:' /tmp/rc_headers.txt 2>/dev/null | sed 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//' | tr -d '\r')"
[ -z "${ETAG}" ] && ETAG='*'

# 2. Merge template -> live, adding ONLY parameters that are absent from live.
#    Never overwrites an existing value. Prints the count of newly-seeded params.
ADDED_COUNT="$(python3 - "${TEMPLATE}" <<'PY'
import json, sys
live = json.load(open('/tmp/rc_live.json'))
tmpl = json.load(open(sys.argv[1]))
live.pop('version', None)   # output-only; must not be echoed back on PUT
live.pop('etag', None)
params = live.setdefault('parameters', {})
added = [k for k in tmpl.get('parameters', {}) if k not in params]
for k in added:
    params[k] = tmpl['parameters'][k]
# Seed conditions / parameter groups only if the live config has none, so we
# never disturb operator-defined targeting.
for key in ('conditions', 'parameterGroups'):
    if tmpl.get(key) and not live.get(key):
        live[key] = tmpl[key]
json.dump(live, open('/tmp/rc_merged.json', 'w'))
sys.stderr.write('Remote Config seed: new params = %s\n' % (added or '(none)'))
print(len(added))
PY
)"

# 3. Nothing new -> leave the live config (and every console value) untouched.
if [ "${ADDED_COUNT}" != "0" ]; then
  # 4. Publish the merged config. Optimistic concurrency via the live ETag when
  #    the API returns one; falls back to '*' otherwise (the merged body already
  #    contains every existing value, so the result is still non-destructive).
  HTTP_CODE="$(curl -s -o /tmp/rc_response.json -w '%{http_code}' -X PUT \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json; charset=UTF-8" \
    -H "If-Match: ${ETAG}" \
    --data-binary @/tmp/rc_merged.json "${RC_URL}")"
  echo "Remote Config seed PUT: HTTP ${HTTP_CODE}"
  cat /tmp/rc_response.json || true
  if [ "${HTTP_CODE}" -lt 200 ] || [ "${HTTP_CODE}" -ge 300 ]; then
    echo "WARNING: Remote Config seed failed — frontend deploy continues."
    exit 0
  fi
  echo "Remote Config seed complete (${ADDED_COUNT} new parameter(s))."
else
  echo "Remote Config: no new parameters to seed; console values left as-is."
fi
