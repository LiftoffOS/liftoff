// browseai overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const BROWSEAI_OVERLAYS: Record<string, ComposioToolOverlay> = {
  BROWSEAI_GET_ROBOTS: { stableName: 'list_robots', categoryOverrides: ["read"] },
  BROWSEAI_GET_ROBOT_TASKS: { stableName: 'list_robot_tasks', categoryOverrides: ["read"] },
  BROWSEAI_GET_TASK_DETAILS: { stableName: 'get_task', categoryOverrides: ["read"] },
  BROWSEAI_RUN_ROBOT: { stableName: 'run_robot', categoryOverrides: ["write"] },
  BROWSEAI_CREATE_MONITOR: { stableName: 'create_monitor', categoryOverrides: ["write"] },
  BROWSEAI_BULK_RUN_TASKS: { stableName: 'bulk_run_tasks', categoryOverrides: ["write"] },
};

export const BROWSEAI_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
