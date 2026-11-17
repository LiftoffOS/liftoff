// Apify overlay. Stable names + categories over the real Composio apify tools.
// translateInput: Composio's param names are already agent-friendly (actorId,
// datasetId, …) so input is passthrough. translateOutput: LEFT PASSTHROUGH —
// no apify connected account exists to verify the real response shape, and the
// skill forbids guessing. TODO(normalize): shape run/dataset outputs to the
// canonical { items, nextPageToken } once a connected account is available.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const APIFY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS: { stableName: 'run_actor_get_items', categoryOverrides: ['write'] },
  APIFY_RUN_ACTOR: { stableName: 'run_actor', categoryOverrides: ['write'] },
  APIFY_RUN_TASK: { stableName: 'run_task', categoryOverrides: ['write'] },
  APIFY_GET_DATASET_ITEMS: { stableName: 'get_dataset_items', categoryOverrides: ['read'] },
  APIFY_GET_LIST_OF_RUNS: { stableName: 'list_runs', categoryOverrides: ['read'] },
  APIFY_GET_ACTOR: { stableName: 'get_actor', categoryOverrides: ['read'] },
  APIFY_GET_LOG: { stableName: 'get_run_log', categoryOverrides: ['read'] },
  APIFY_GET_LIST_OF_TASKS: { stableName: 'list_tasks', categoryOverrides: ['read'] },
  APIFY_GET_KEY_VALUE_RECORD: { stableName: 'get_key_value_record', categoryOverrides: ['read'] },
};

export const APIFY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
