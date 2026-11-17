// BigQuery Client Infrastructure
// Thin singleton wrapper around @google-cloud/bigquery.
// Credentials come from Application Default Credentials (ADC) — the Cloud Run
// service account has BigQuery Data Viewer IAM on the billing export dataset.

import { BigQuery } from '@google-cloud/bigquery';

let _client: BigQuery | null = null;

export function getBigQueryClient(): BigQuery {
  if (!_client) {
    _client = new BigQuery({
      projectId: process.env.GCP_PROJECT_ID,
    });
  }
  return _client;
}
