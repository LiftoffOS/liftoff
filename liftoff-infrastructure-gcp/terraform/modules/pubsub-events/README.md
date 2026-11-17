# pubsub-events

Per-service Pub/Sub topics owned by their producing service (plan 0w).

## What it provisions

- `billing-events-${env}`, `workforce-events-${env}`,
  `developer-proxy-usage-${env}` — topics.
- `<topic>-dlq` — companion dead-letter topics; subscribers configure
  `dead_letter_policy` pointing at these.
- `roles/pubsub.publisher` bindings for the producing SAs (passed in via
  `publisher_sa_emails`).

## Why topics here, subscriptions elsewhere

Plan 0w: topics are owned by the producer so the producer controls the
schema / retention / CMEK. Subscriptions are owned by the consumer so the
subscriber controls ack deadlines, filters, and DLQ policy. Keeping
subscriptions out of this module forces that boundary.

## Inputs

| Name | Description |
|------|-------------|
| `topics` | Map `key => { ordering, retention, dlq_retention }` |
| `publisher_sa_emails` | Map `topic-key => SA email` |
| `kms_key_id` | Optional CMEK |
