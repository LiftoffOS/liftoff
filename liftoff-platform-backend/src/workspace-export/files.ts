// files/: every file the teams produced, as bytes.
//
// Each produced file sits under a folder named for the conversation it was
// produced in (`<yyyy-mm-dd>-<conversation-title-slug>/`), or for the team
// when it was produced outside any conversation (a scheduled run's output),
// with the filename the card shows. Two identical names in one folder get
// ` (2)`, ` (3)`. The SIZES are summed from size_bytes and charged to the
// budget BEFORE any byte is fetched, so a too-large workspace gets its 413
// without a single download; the bytes themselves are read last of
// everything, so every cheaper way to fail has been tried before the bucket is
// touched. A connector-native row (gdoc, gslides: no bytes here, a link in
// the customer's Drive) is a stable link, not a file. An object missing from
// the bucket is a name with no path.

import { generatedFilesBucket } from '../generated-files/gcs-client';
import { log } from '../infrastructure/logging';
import type { ExportBudget } from './budget';
import type { GeneratedFileRow } from './queries';
import type { FileEntry, FileResolver, FileReference } from './conversations';
import { ARCHIVE_FILES, CONVERSATION_KEYS as K, UNTITLED_CHAT } from './labels';

/** Lower-cased, `[^a-z0-9]+` → `-`, trimmed of `-`, at most 40 characters,
 *  `fallback` when nothing survives. The same rule names the archive. */
export function slugify(text: string | null | undefined, fallback: string): string {
  const slug = (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : fallback;
}

/** `files/<folder>/<name>`, with ` (n)` before the extension on a repeat. */
function uniquePath(folder: string, filename: string, taken: Set<string>): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let candidate = `${ARCHIVE_FILES.filesDir}/${folder}/${filename}`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${ARCHIVE_FILES.filesDir}/${folder}/${stem} (${n})${ext}`;
    n += 1;
  }
  taken.add(candidate);
  return candidate;
}

export interface PlannedFile {
  id: string;
  name: string;
  /** The zip path, or null for a connector-native row or one whose bytes were
   *  not there. */
  path: string | null;
  link: string | null;
  gcsPath: string | null;
  sizeBytes: number;
}

export interface FilePlan {
  files: PlannedFile[];
  byId: Map<string, PlannedFile>;
}

/** Where a conversation's files go: the date it started and its title. */
export interface ConversationFolder {
  createdAt: Date;
  title: string | null;
}

/** The size precheck: every stored object's size_bytes, summed and charged
 *  against the budget before a single download, so a too-large workspace gets
 *  its 413 with the bucket untouched. */
export function chargeFileSizes(rows: GeneratedFileRow[], budget: ExportBudget): number {
  let totalBytes = 0;
  for (const row of rows) {
    if (row.gcs_path) totalBytes += Number(row.size_bytes ?? 0) || 0;
  }
  budget.chargeBytes(totalBytes);
  return totalBytes;
}

/**
 * Lay the files out. No byte is fetched here.
 *
 * `conversationFolders` maps a thread id (any surface) to the conversation;
 * a file whose conversation is not in the export sits under its team.
 */
export function planFiles(
  rows: GeneratedFileRow[],
  conversationFolders: ReadonlyMap<string, ConversationFolder>,
): FilePlan {
  const taken = new Set<string>();
  const files: PlannedFile[] = [];
  const byId = new Map<string, PlannedFile>();
  for (const row of rows) {
    const conversation = row.conversation_id ? conversationFolders.get(row.conversation_id) : undefined;
    const folder = conversation
      ? `${conversation.createdAt.toISOString().slice(0, 10)}-${slugify(conversation.title ?? UNTITLED_CHAT, 'untitled-chat')}`
      : slugify(row.agent_name, 'team');
    const planned: PlannedFile = {
      id: row.id,
      name: row.filename,
      path: row.gcs_path ? uniquePath(folder, row.filename, taken) : null,
      link: row.gcs_path ? null : (row.web_view_url ?? null),
      gcsPath: row.gcs_path,
      sizeBytes: Number(row.size_bytes ?? 0) || 0,
    };
    files.push(planned);
    byId.set(planned.id, planned);
  }
  return { files, byId };
}

/** At most this many objects in flight. */
const DOWNLOAD_CONCURRENCY = 10;

/**
 * Fetch every planned object. A missing object clears the file's path so the
 * transcript names it without pointing at it; any other failure propagates.
 */
export async function downloadFiles(
  plan: FilePlan,
  download: (gcsPath: string) => Promise<Buffer> = defaultDownload,
): Promise<Map<string, Buffer>> {
  const bytesByPath = new Map<string, Buffer>();
  const queue = plan.files.filter((f) => f.path !== null && f.gcsPath !== null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const file = queue[next];
      next += 1;
      if (!file) return;
      try {
        const bytes = await download(file.gcsPath as string);
        bytesByPath.set(file.path as string, bytes);
      } catch (err) {
        if (isNotFound(err)) {
          log.warn({ gcsPath: file.gcsPath }, 'workspace-export: produced file missing from the bucket');
          file.path = null;
          continue;
        }
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) }, worker));
  return bytesByPath;
}

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 404 || code === 'ENOENT';
}

async function defaultDownload(gcsPath: string): Promise<Buffer> {
  // generated-files/router.ts:654: the same read the media route makes.
  const [bytes] = await generatedFilesBucket().file(gcsPath).download();
  return bytes;
}

/** The join that gives each transcript Files entry its Path or Link: the
 *  bytes under files/ when the object is here, else the stored row's link,
 *  else the link the card itself carries (a document written through a
 *  connector has no row at all), else the name alone. */
export function fileResolver(plan: FilePlan): FileResolver {
  return (ref: FileReference): FileEntry => {
    const planned = plan.byId.get(ref.fileId);
    const name = planned?.name ?? ref.filename;
    if (planned?.path) return { [K.name]: name, [K.path]: planned.path };
    const link = planned?.link ?? ref.webViewUrl;
    if (link) return { [K.name]: name, [K.link]: link };
    return { [K.name]: name };
  };
}
