// One-shot operator script: bulk-arm Gmail watches for every google_mail
// connector that has no row in gmail_watch_subscriptions.
//
// Why this exists: webhook arming for composio_managed connectors fails if
// connector-service's webhook endpoint requires a connector_credentials row,
// which those connectors do not have. connector-service handles that via a
// Composio internal-adapter behind getCredentials, but existing Gmail
// connectors whose initial-arm silently never happened (or whose subscription
// row was dropped) stay un-armed and won't see new email pushes.
//
// `handleCredentialsStored` (events/subscriber.ts) now auto-arms on
// future connect events, so this is strictly for backfilling existing
// state.
//
// Cloud Run Job invocation (per-tenant runtime project, e.g.
// YOUR_TENANT_PROJECT). Use the tenant-runtime image SHA that
// contains this script:
//
//   gcloud run jobs create arm-missing-gmail-watches \
//     --image=us-west1-docker.pkg.dev/YOUR_CONTROL_PROJECT/YOUR_ARTIFACT_REPO/tenant-runtime:<sha> \
//     --region=us-west1 \
//     --project=YOUR_TENANT_PROJECT \
//     --service-account=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com \
//     --set-cloudsql-instances=YOUR_TENANT_PROJECT:us-west1:YOUR_TENANT_PROJECT \
//     --network=<your-vpc> --subnet=<your-subnet> \
//     --vpc-egress=private-ranges-only \
//     --set-secrets=DB_PASSWORD=tenant-db-password:latest,CONNECTOR_SERVICE_TOKEN=connector-service-token:latest \
//     --set-env-vars="DB_HOST=<private-ip>,DB_USER=tenant_app,DB_NAME=tenant_runtime,CONNECTOR_SERVICE_URL=<your-api-host>,GCP_PROJECT=<your-tenant-project>,ENVIRONMENT=prod,SERVICE_TYPE=agent" \
//     --command=node --args="dist/scripts/arm-missing-gmail-watches.js" \
//     --task-timeout=600 --max-retries=0
//   gcloud run jobs execute arm-missing-gmail-watches --region=<your-region> --project=<your-tenant-project> --wait
//   gcloud run jobs delete arm-missing-gmail-watches --region=us-west1 --project=YOUR_TENANT_PROJECT --quiet

import { armMissingGmailWatches } from '../connectors/gmail-watch';
import { logger } from '../infrastructure/logging';
import { loadSecretsToEnv } from '../infrastructure/secrets';

async function main(): Promise<void> {
  await loadSecretsToEnv();
  logger.info('arm-missing-gmail-watches: starting');
  const result = await armMissingGmailWatches();
  logger.info(
    {
      candidates: result.candidates,
      armed: result.armed,
      failed: result.failed,
    },
    'arm-missing-gmail-watches: complete',
  );
  if (result.failed > 0) {
    // Non-zero exit so Cloud Run Job execution surfaces as failed and the
    // operator sees it in the console.
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: (err as Error).message }, 'arm-missing-gmail-watches: fatal');
    process.exit(2);
  });
