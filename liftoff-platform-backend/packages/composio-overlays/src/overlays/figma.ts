// figma overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const FIGMA_OVERLAYS: Record<string, ComposioToolOverlay> = {
  FIGMA_GET_FILES_IN_A_PROJECT: { stableName: 'list_files', categoryOverrides: ["read"] },
  FIGMA_GET_FILE_JSON: { stableName: 'get_file', categoryOverrides: ["read"] },
  FIGMA_GET_PROJECTS_IN_A_TEAM: { stableName: 'list_projects', categoryOverrides: ["read"] },
  FIGMA_GET_COMMENTS_IN_A_FILE: { stableName: 'list_comments', categoryOverrides: ["read"] },
  FIGMA_GET_FILE_COMPONENTS: { stableName: 'list_file_components', categoryOverrides: ["read"] },
  FIGMA_GET_CURRENT_USER: { stableName: 'get_current_user', categoryOverrides: ["read"] },
  FIGMA_DISCOVER_FIGMA_RESOURCES: { stableName: 'discover_resources', categoryOverrides: ["read"] },
  FIGMA_DOWNLOAD_FIGMA_IMAGES: { stableName: 'download_images', categoryOverrides: ["read"] },
  FIGMA_EXTRACT_DESIGN_TOKENS: { stableName: 'extract_design_tokens', categoryOverrides: ["read"] },
  FIGMA_ADD_A_COMMENT_TO_A_FILE: { stableName: 'add_comment', categoryOverrides: ["write"] },
  FIGMA_CREATE_DEV_RESOURCES: { stableName: 'create_dev_resources', categoryOverrides: ["write"] },
};

export const FIGMA_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
