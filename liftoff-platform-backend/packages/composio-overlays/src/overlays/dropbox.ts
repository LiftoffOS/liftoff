// dropbox overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const DROPBOX_OVERLAYS: Record<string, ComposioToolOverlay> = {
  DROPBOX_LIST_FOLDERS: { stableName: 'list_folders', categoryOverrides: ["read"] },
  DROPBOX_LIST_FILES_IN_FOLDER: { stableName: 'list_files', categoryOverrides: ["read"] },
  DROPBOX_SEARCH_FILE_OR_FOLDER: { stableName: 'search', categoryOverrides: ["read"] },
  DROPBOX_READ_FILE: { stableName: 'read_file', categoryOverrides: ["read"] },
  DROPBOX_UPLOAD_FILE: { stableName: 'upload_file', categoryOverrides: ["write"] },
  DROPBOX_CREATE_FOLDER: { stableName: 'create_folder', categoryOverrides: ["write"] },
  DROPBOX_MOVE_FILE_OR_FOLDER: { stableName: 'move', categoryOverrides: ["write"] },
  DROPBOX_CREATE_PAPER: { stableName: 'create_paper', categoryOverrides: ["write"] },
  DROPBOX_GET_ABOUT_ME: { stableName: 'get_current_user', categoryOverrides: ["read"] },
  DROPBOX_DELETE_FILE_OR_FOLDER: { stableName: 'delete', categoryOverrides: ["write","destructive"] },
};

export const DROPBOX_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
