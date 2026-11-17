// ticktick overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const TICKTICK_OVERLAYS: Record<string, ComposioToolOverlay> = {
  TICKTICK_GET_USER_PROJECT: { stableName: 'list_projects', categoryOverrides: ["read"] },
  TICKTICK_TICKTICK_GET_PROJECT_WITH_DATA: { stableName: 'get_project', categoryOverrides: ["read"] },
  TICKTICK_CREATE_TASK: { stableName: 'create_task', categoryOverrides: ["write"] },
  TICKTICK_UPDATE_TASK: { stableName: 'update_task', categoryOverrides: ["write"] },
  TICKTICK_COMPLETE_TASK: { stableName: 'complete_task', categoryOverrides: ["write"] },
  TICKTICK_TICKTICK_CREATE_PROJECT: { stableName: 'create_project', categoryOverrides: ["write"] },
  TICKTICK_TICKTICK_UPDATE_PROJECT: { stableName: 'update_project', categoryOverrides: ["write"] },
};

export const TICKTICK_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
