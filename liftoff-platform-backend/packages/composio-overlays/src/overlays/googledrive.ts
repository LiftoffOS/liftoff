// googledrive overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.
//
// Write-provenance declarations below are in CANONICAL shape. Nothing here
// translates input or output, so the canonical names ARE Composio's: `idArgs`
// name arguments off each tool's input_parameters, and `returnsIds` paths are
// read against `data` off its output_parameters.
//
// Two of those are easy to get wrong by pattern. `share_file` returns a
// PERMISSION resource, so its `id` is a permission id and naming it a file
// would teach the run that it had seen a file it never saw. And `delete` takes
// `fileId` where every other tool here takes `file_id` — Composio's naming, not
// ours to correct.
//
// `download_file` returns the content as a signed URL of Composio's copy
// (`downloaded_file_content.s3url`, off its output_parameters). That URL is for
// the PERSON: nothing in this platform reads it, and in the model's context it
// is a credential-bearing link one summary away from being quoted into a
// message, stored and learned from. It is declared `egressOnly`, so the runtime
// hands it to the surface and shows the model a placeholder. The durable Drive
// links (`webViewLink`, `webContentLink`) are NOT: sharing those is often the
// agent's job, and a field lifted on a run with no chat surface reaches nobody.
import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const GOOGLEDRIVE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GOOGLEDRIVE_FIND_FILE: {
    stableName: 'find_file',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'file', path: 'files[].id' }],
  },
  GOOGLEDRIVE_FIND_FOLDER: {
    stableName: 'find_folder',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'folder', path: 'files[].id' }],
  },
  GOOGLEDRIVE_GET_FILE_METADATA: {
    stableName: 'get_file_metadata',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'file', path: 'id' }],
  },
  GOOGLEDRIVE_DOWNLOAD_FILE: {
    stableName: 'download_file',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'file', path: 'id' }],
    egressOnly: ['downloaded_file_content.s3url'],
  },
  GOOGLEDRIVE_CREATE_FILE: {
    stableName: 'create_file',
    categoryOverrides: ['write'],
    returnsIds: [{ entityType: 'file', path: 'id' }],
  },
  GOOGLEDRIVE_CREATE_FILE_FROM_TEXT: {
    stableName: 'create_file_from_text',
    categoryOverrides: ['write'],
    returnsIds: [{ entityType: 'file', path: 'id' }],
  },
  GOOGLEDRIVE_CREATE_FOLDER: {
    stableName: 'create_folder',
    categoryOverrides: ['write'],
    returnsIds: [{ entityType: 'folder', path: 'id' }],
  },
  GOOGLEDRIVE_COPY_FILE: {
    stableName: 'copy_file',
    categoryOverrides: ['write'],
    idArgs: ['file_id'],
    returnsIds: [{ entityType: 'file', path: 'id' }],
  },
  GOOGLEDRIVE_EDIT_FILE: {
    stableName: 'edit_file',
    categoryOverrides: ['write'],
    idArgs: ['file_id'],
    returnsIds: [{ entityType: 'file', path: 'id' }],
  },
  GOOGLEDRIVE_ADD_FILE_SHARING_PREFERENCE: {
    stableName: 'share_file',
    categoryOverrides: ['write'],
    idArgs: ['file_id'],
    returnsIds: [{ entityType: 'permission', path: 'id' }],
  },
  GOOGLEDRIVE_GOOGLE_DRIVE_DELETE_FOLDER_OR_FILE_ACTION: {
    stableName: 'delete',
    categoryOverrides: ['write', 'destructive'],
    idArgs: ['fileId'],
  },
};

export const GOOGLEDRIVE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
