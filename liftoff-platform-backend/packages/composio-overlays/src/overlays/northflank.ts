// northflank overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const NORTHFLANK_OVERLAYS: Record<string, ComposioToolOverlay> = {
  NORTHFLANK_LIST_PROJECTS: { stableName: 'list_projects', categoryOverrides: ["read"] },
  NORTHFLANK_GET_PROJECT: { stableName: 'get_project', categoryOverrides: ["read"] },
  NORTHFLANK_LIST_SERVICES: { stableName: 'list_services', categoryOverrides: ["read"] },
  NORTHFLANK_LIST_PIPELINES: { stableName: 'list_pipelines', categoryOverrides: ["read"] },
  NORTHFLANK_LIST_PLANS: { stableName: 'list_plans', categoryOverrides: ["read"] },
  NORTHFLANK_LIST_REGIONS: { stableName: 'list_regions', categoryOverrides: ["read"] },
  NORTHFLANK_LIST_ADDON_TYPES: { stableName: 'list_addon_types', categoryOverrides: ["read"] },
  NORTHFLANK_CREATE_PROJECT: { stableName: 'create_project', categoryOverrides: ["write"] },
  NORTHFLANK_UPDATE_PROJECT: { stableName: 'update_project', categoryOverrides: ["write"] },
};

export const NORTHFLANK_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
