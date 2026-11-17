// FALLBACK-AUTHORED registry functions — Apify, on a workspace's OWN account.
// Basis: Apify API v2 (docs.apify.com/api/v2), the actor-run surface the
// platform's own executor (platform-backend, src/capability-discovery/
// apify-executor.ts) already drives. Hand-authored to src/clients/apify.ts and
// the two stay in lock-step (each name below is a case there). This connector
// is BYO-key only: a workspace connects its Apify account and its runs are
// paid by that account (`tenant_key`), so the platform charges no Operating
// Units for the vendor part. Without a connected account the platform runs
// Store actors on its own rungs (the x402 prepaid token, then the platform
// account) from platform-backend, not from here.

import type { ConnectorFunction } from '../../types.js';

const ACTOR_ID = {
  type: 'string',
  description: 'Actor reference: "username/actor-name" as the Store lists it, or the actor id',
} as const;

export const APIFY_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'run_actor',
    description:
      'Run a public Apify Store actor on the connected account and return its dataset items. '
      + 'Waits for the run to finish (about ninety seconds at most) and caps what one run may '
      + 'charge and how many items it returns.',
    inputSchema: {
      type: 'object',
      properties: {
        actorId: ACTOR_ID,
        input: { type: 'object', description: "The actor's input, as its input schema describes it" },
        maxItems: { type: 'integer', description: 'Most dataset items to return and, for a pay-per-result actor, to charge for (default 100)' },
        maxTotalChargeUsd: { type: 'number', description: 'Most this run may charge in USD, whatever the actor prices (default 1)' },
      },
      required: ['actorId', 'input'],
    },
    categories: ['read'],
  },
  {
    name: 'get_dataset_items',
    description: 'Read the items of a dataset a previous run produced, in pages',
    inputSchema: {
      type: 'object',
      properties: {
        datasetId: { type: 'string', description: 'Dataset id (a run record carries its defaultDatasetId)' },
        limit: { type: 'integer', description: 'Items per page (default 100)' },
        offset: { type: 'integer', description: 'Items to skip' },
      },
      required: ['datasetId'],
    },
    categories: ['read'],
  },
  {
    name: 'get_actor',
    description: "Read an actor's record: title, description, current pricing model and input schema reference",
    inputSchema: {
      type: 'object',
      properties: { actorId: ACTOR_ID },
      required: ['actorId'],
    },
    categories: ['read'],
  },
  {
    name: 'list_runs',
    description: "List the connected account's recent actor runs, newest first",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Runs to return (default 20, most 100)' },
        status: { type: 'string', description: 'Only runs in this status, for example SUCCEEDED or FAILED' },
      },
    },
    categories: ['read'],
  },
];
