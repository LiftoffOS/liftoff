// todoist overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const TODOIST_OVERLAYS: Record<string, ComposioToolOverlay> = {
  TODOIST_GET_ALL_PROJECTS: { stableName: 'list_projects', categoryOverrides: ["read"] },
  TODOIST_GET_ALL_SECTIONS: { stableName: 'list_sections', categoryOverrides: ["read"] },
  TODOIST_GET_ALL_LABELS: { stableName: 'list_labels', categoryOverrides: ["read"] },
  TODOIST_GET_ALL_COMMENTS: { stableName: 'list_comments', categoryOverrides: ["read"] },
  TODOIST_CREATE_TASK: { stableName: 'create_task', categoryOverrides: ["write"] },
  TODOIST_UPDATE_TASK: { stableName: 'update_task', categoryOverrides: ["write"] },
  TODOIST_CLOSE_TASK: { stableName: 'complete_task', categoryOverrides: ["write"] },
  TODOIST_CREATE_PROJECT: { stableName: 'create_project', categoryOverrides: ["write"] },
  TODOIST_CREATE_SECTION: { stableName: 'create_section', categoryOverrides: ["write"] },
  TODOIST_CREATE_COMMENT: { stableName: 'create_comment', categoryOverrides: ["write"] },
  TODOIST_CREATE_LABEL: { stableName: 'create_label', categoryOverrides: ["write"] },
};

export const TODOIST_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
