// File API contract types
// Mirrors agent-infra/sandbox sdk/js/src/api/resources/file/types
// Plus StrReplaceEditor (Anthropic-compatible text editor tool).

export interface FileReadRequest {
  path: string;
  offset?: number;
  limit?: number;
  encoding?: 'utf-8' | 'base64';
}

export interface FileReadResponse {
  content: string;
  totalBytes: number;
}

export interface FileWriteRequest {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
  makeDirs?: boolean;
}

export interface FileWriteResponse {
  path: string;
  bytesWritten: number;
}

export interface FileReplaceRequest {
  path: string;
  oldText: string;
  newText: string;
}

export interface FileReplaceResponse {
  path: string;
  replacements: number;
}

export type StrReplaceEditorCommand = 'view' | 'create' | 'str_replace' | 'insert' | 'undo_edit';

export interface StrReplaceEditorRequest {
  command: StrReplaceEditorCommand;
  path: string;
  file_text?: string;
  view_range?: [number, number];
  old_str?: string;
  new_str?: string;
  insert_line?: number;
}

export interface StrReplaceEditorResponse {
  result: string;
}

export interface FileSearchRequest {
  pattern: string;
  path?: string;
  glob?: string;
  regex?: boolean;
  case_insensitive?: boolean;
  max_results?: number;
}

export interface FileGrepRequest {
  pattern: string;
  path?: string;
  glob?: string;
}

export interface FileMatch {
  path: string;
  line: number;
  text: string;
}

export interface FileSearchResponse {
  matches: FileMatch[];
}

export interface FileGrepResponse {
  matches: FileMatch[];
}

export interface FileFindRequest {
  pattern: string;
  path?: string;
  type?: 'f' | 'd';
  max_depth?: number;
}

export interface FileFindResponse {
  paths: string[];
}

export interface FileGlobRequest {
  pattern: string;
  root?: string;
}

export interface FileGlobResponse {
  paths: string[];
}

export interface FileListRequest {
  path: string;
  recursive?: boolean;
  max_depth?: number;
}

export interface FileListEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: string;
}

export interface FileListResponse {
  entries: FileListEntry[];
}

export interface FileWatchCreateRequest {
  paths: string[];
  events?: Array<'add' | 'change' | 'unlink'>;
}

export interface FileWatchHandle {
  watcher_id: string;
}

export interface FileWatchEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  ts: number;
}

export interface FileWatchPollRequest {
  watcher_id: string;
  since?: number;
}

export interface FileWatchPollResponse {
  events: FileWatchEvent[];
}

export interface FileWatchWaitRequest {
  watcher_id: string;
  timeout_ms: number;
}

export interface FileWatchListResponse {
  watchers: Array<{ id: string; paths: string[]; created_at: string }>;
}

export interface FileWatchStopRequest {
  watcher_id: string;
}
