// clickup overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const CLICKUP_OVERLAYS: Record<string, ComposioToolOverlay> = {
  CLICKUP_GET_TASKS: { stableName: 'list_tasks', categoryOverrides: ["read"] },
  CLICKUP_GET_TASK: { stableName: 'get_task', categoryOverrides: ["read"] },
  CLICKUP_GET_FILTERED_TEAM_TASKS: { stableName: 'search_tasks', categoryOverrides: ["read"] },
  CLICKUP_GET_TASK_COMMENTS: { stableName: 'list_task_comments', categoryOverrides: ["read"] },
  CLICKUP_GET_LISTS: { stableName: 'list_lists', categoryOverrides: ["read"] },
  CLICKUP_GET_LIST: { stableName: 'get_list', categoryOverrides: ["read"] },
  CLICKUP_GET_FOLDERS: { stableName: 'list_folders', categoryOverrides: ["read"] },
  CLICKUP_GET_SPACES: { stableName: 'list_spaces', categoryOverrides: ["read"] },
  CLICKUP_CREATE_TASK: { stableName: 'create_task', categoryOverrides: ["write"] },
  CLICKUP_UPDATE_TASK: { stableName: 'update_task', categoryOverrides: ["write"] },
  CLICKUP_CREATE_TASK_COMMENT: { stableName: 'create_task_comment', categoryOverrides: ["write"] },
  CLICKUP_ADD_TAG_TO_TASK: { stableName: 'add_tag_to_task', categoryOverrides: ["write"] },
  CLICKUP_CREATE_LIST: { stableName: 'create_list', categoryOverrides: ["write"] },
  CLICKUP_CREATE_FOLDER: { stableName: 'create_folder', categoryOverrides: ["write"] },
};

export const CLICKUP_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
