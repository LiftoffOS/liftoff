// one_drive overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.
//
// `download_file` returns the content as a signed URL of Composio's copy
// (`content.s3url`, off its output_parameters): for the person, not the model.
// Declared `egressOnly` for the reasons given on the googledrive overlay. The
// sharing link `create_link` returns is not — producing a link to share is
// what that tool is for.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ONE_DRIVE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  ONE_DRIVE_COPY_ITEM: { stableName: 'copy_item', categoryOverrides: ["write"] },
  ONE_DRIVE_CREATE_LINK: { stableName: 'create_link', categoryOverrides: ["write"] },
  ONE_DRIVE_DELETE_ITEM: { stableName: 'delete_item', categoryOverrides: ["write","destructive"] },
  ONE_DRIVE_DOWNLOAD_FILE: { stableName: 'download_file', categoryOverrides: ["read"], egressOnly: ['content.s3url'] },
  ONE_DRIVE_GET_DRIVE: { stableName: 'get_drive', categoryOverrides: ["read"] },
  ONE_DRIVE_GET_ITEM: { stableName: 'get_item', categoryOverrides: ["read"] },
  ONE_DRIVE_GET_ITEM_PERMISSIONS: { stableName: 'get_item_permissions', categoryOverrides: ["read"] },
  ONE_DRIVE_GET_ITEM_THUMBNAILS: { stableName: 'get_item_thumbnails', categoryOverrides: ["read"] },
  ONE_DRIVE_GET_ITEM_VERSIONS: { stableName: 'get_item_versions', categoryOverrides: ["read"] },
  ONE_DRIVE_GET_QUOTA: { stableName: 'get_quota', categoryOverrides: ["read"] },
  ONE_DRIVE_GET_RECENT_ITEMS: { stableName: 'get_recent_items', categoryOverrides: ["read"] },
  ONE_DRIVE_GET_SHARED_ITEMS: { stableName: 'get_shared_items', categoryOverrides: ["read"] },
  ONE_DRIVE_GET_SHAREPOINT_LIST_ITEMS: { stableName: 'get_sharepoint_list_items', categoryOverrides: ["read"] },
  ONE_DRIVE_GET_SITE_DETAILS: { stableName: 'get_site_details', categoryOverrides: ["read"] },
  ONE_DRIVE_GET_SITE_PAGE_CONTENT: { stableName: 'get_site_page_content', categoryOverrides: ["read"] },
  ONE_DRIVE_INVITE_USER_TO_DRIVE_ITEM: { stableName: 'invite_user_to_drive_item', categoryOverrides: ["write"] },
  ONE_DRIVE_LIST_DRIVE_ITEM_ACTIVITIES: { stableName: 'list_drive_item_activities', categoryOverrides: ["read"] },
  ONE_DRIVE_LIST_DRIVES: { stableName: 'list_drives', categoryOverrides: ["read"] },
  ONE_DRIVE_LIST_ROOT_DRIVE_CHANGES: { stableName: 'list_root_drive_changes', categoryOverrides: ["read"] },
  ONE_DRIVE_LIST_SHAREPOINT_LIST_ITEMS_DELTA: { stableName: 'list_sharepoint_list_items_delta', categoryOverrides: ["read"] },
  ONE_DRIVE_LIST_SITE_COLUMNS: { stableName: 'list_site_columns', categoryOverrides: ["read"] },
  ONE_DRIVE_LIST_SITE_DRIVE_ITEMS_DELTA: { stableName: 'list_site_drive_items_delta', categoryOverrides: ["read"] },
  ONE_DRIVE_LIST_SITE_LISTS: { stableName: 'list_site_lists', categoryOverrides: ["read"] },
  ONE_DRIVE_LIST_SITE_SUBSITES: { stableName: 'list_site_subsites', categoryOverrides: ["read"] },
  ONE_DRIVE_LIST_SUBSCRIPTIONS: { stableName: 'list_subscriptions', categoryOverrides: ["read"] },
  ONE_DRIVE_MOVE_ITEM: { stableName: 'move_item', categoryOverrides: ["write"] },
  ONE_DRIVE_ONEDRIVE_CREATE_FOLDER: { stableName: 'create_folder', categoryOverrides: ["write"] },
  ONE_DRIVE_ONEDRIVE_CREATE_TEXT_FILE: { stableName: 'create_text_file', categoryOverrides: ["write"] },
  ONE_DRIVE_ONEDRIVE_FIND_FILE: { stableName: 'find_file', categoryOverrides: ["read"] },
  ONE_DRIVE_ONEDRIVE_FIND_FOLDER: { stableName: 'find_folder', categoryOverrides: ["read"] },
  ONE_DRIVE_ONEDRIVE_LIST_ITEMS: { stableName: 'list_items', categoryOverrides: ["read"] },
  ONE_DRIVE_ONEDRIVE_UPLOAD_FILE: { stableName: 'upload_file', categoryOverrides: ["write"] },
  ONE_DRIVE_PREVIEW_DRIVE_ITEM: { stableName: 'preview_drive_item', categoryOverrides: ["read"] },
  ONE_DRIVE_SEARCH_ITEMS: { stableName: 'search_items', categoryOverrides: ["read"] },
  ONE_DRIVE_UPDATE_DRIVE_ITEM_METADATA: { stableName: 'update_drive_item_metadata', categoryOverrides: ["write"] },
};

export const ONE_DRIVE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
