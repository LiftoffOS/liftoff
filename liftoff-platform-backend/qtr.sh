#!/bin/bash
set +e
SQL="$1"
PROJ=YOUR_TENANT_PROJECT
OUT=$(gcloud run jobs execute tr-psql-probe --project=$PROJ --region=us-west1 \
  --args="^~^-c~$SQL" --wait 2>&1)
EXEC=$(echo "$OUT" | grep -oE 'tr-psql-probe-[a-z0-9]{5}' | head -1)
echo "exec=$EXEC" >&2
for i in 1 2 3 4 5 6; do
  sleep 6
  RES=$(gcloud logging read "resource.type=cloud_run_job AND labels.\"run.googleapis.com/execution_name\"=\"$EXEC\"" \
    --project=$PROJ --limit=400 --format="value(textPayload)" --order=asc)
  if [ -n "$RES" ]; then echo "$RES"; exit 0; fi
done
echo "$RES"
