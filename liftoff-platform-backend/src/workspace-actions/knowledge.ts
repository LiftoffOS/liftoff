// The knowledge library, as the Knowledge page works it: what is in it (with the
// reason an entry could not be read, which is the field the page shows and this
// view used to drop), adding a page by URL the way "Add URL" does, adding a file
// from a connected app the way the file picker does, and reading one entry again
// in place.
//
// The library is workspace-scoped context, so a write needs explicit consent
// (preview → confirm on the tool) and knowledge:write. It is a curated help
// centre for the teams, never a dump target: one item per call, with a title.

import * as knowledgeService from '../knowledge/service';
import type { ContentType, KnowledgeItem } from '../knowledge/types';
import { listConnectorsForTenant } from '../connectors/connector-service-client';
import { showsAsConnected } from './connections';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

export type KnowledgeRefusal = { refused: 'validation'; message: string };

/** Every kind a library entry can be, as `ContentType` defines them. A source
 *  says which one a thing is when it is browsed, and that word decides how its
 *  text is read later, so it travels rather than being narrowed here. */
const KNOWLEDGE_CONTENT_TYPES: ReadonlySet<string> = new Set<ContentType>([
  'article', 'document', 'page', 'folder', 'collection', 'url',
]);

/** The kinds that hold other things instead of text of their own. Extraction
 *  treats both as legitimately empty, and the batch endpoint sets them to
 *  `none`; a container marked `pending` would be retried forever for text it
 *  never had. */
const CONTAINER_CONTENT_TYPES: ReadonlySet<string> = new Set<ContentType>(['folder', 'collection']);

/** One library entry, as the Knowledge page shows it.
 *
 *  `syncError` is the load-bearing field. When a file
 *  syncs but its text cannot be read, the platform writes a short reason a
 *  person can act on ("This file contains only its title, so there is nothing
 *  to read. Its content may live in the tool that created it rather than in the
 *  file.") and the Knowledge page shows it in a tooltip on the row. A view that
 *  carries the failure and not the reason lets the assistant tell a person "The
 *  library does not record why it failed" — of a row whose reason their own page
 *  is displaying — and then propose re-adding the file as a web link, which
 *  would fail the same way and leave a second dead entry.
 *
 *  A view of a page that omits what the page says is worse than no view: it
 *  turns a diagnosis the platform already made into a contradiction. */
function itemView(item: KnowledgeItem) {
  return {
    id: item.id,
    title: item.title,
    contentType: item.contentType,
    sourceUrl: item.sourceUrl,
    connectorType: item.connectorType,
    connectorId: item.connectorId,
    importMode: item.importMode,
    syncStatus: item.syncStatus,
    extractionStatus: item.extractionStatus,
    syncError: item.syncError,
    excerpt: item.excerpt,
    updatedAt: item.updatedAt,
  };
}

export async function listKnowledge(actor: Actor) {
  const items = await knowledgeService.listItems(actor.tenantId);
  return { count: items.length, items: items.map(itemView) };
}

export async function addKnowledgeUrl(actor: Actor, p: { title: string; sourceUrl: string }) {
  requirePermission(actor, 'knowledge:write');
  const title = p.title.trim();
  if (title.length === 0 || title.length > 500) {
    return { refused: 'validation', message: 'The title must be between 1 and 500 characters.' } as KnowledgeRefusal;
  }
  let url: URL;
  try {
    url = new URL(p.sourceUrl);
  } catch {
    return { refused: 'validation', message: 'sourceUrl must be a full URL.' } as KnowledgeRefusal;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { refused: 'validation', message: 'sourceUrl must be an http or https URL.' } as KnowledgeRefusal;
  }
  const item = await knowledgeService.createItem(actor.tenantId, {
    title,
    sourceUrl: url.toString(),
    contentType: 'url',
    importMode: 'manual',
  });
  writeAudit(actor, 'knowledge.item_added', {
    resourceType: 'knowledge_item',
    resourceId: item.id,
    newState: { id: item.id, contentType: item.contentType, title: item.title, sourceUrl: item.sourceUrl, importMode: item.importMode },
  });
  return { added: true, item: itemView(item) };
}

/**
 * The files a connected app holds, so a file can be added the way the Knowledge
 * page adds one.
 *
 * The page does this in two steps: browse the connector, then create items that
 * carry the file's own id. Until now an assistant had only `addKnowledgeUrl`, so
 * asked to fix a Drive document that would not read it offered to add the same
 * document again AS A WEB LINK — and said in the same breath that the library
 * would probably pick up a Google sign-in page instead of the notes, and that
 * the broken entry would stay. It reached for a remedy it knew was bad because
 * it had no other. This is the other.
 */
export async function browseKnowledgeSource(
  actor: Actor,
  p: { connectorId: string; query?: string; folderId?: string; cursor?: string; entityType?: string; mimeTypes?: string },
) {
  const connectorId = p.connectorId.trim();
  if (!connectorId) {
    return { refused: 'validation', message: 'connectorId is required; connections_list gives the id of a connected app.' } as KnowledgeRefusal;
  }
  const result = await knowledgeService.browseConnector(actor.tenantId, connectorId, {
    ...(p.query ? { query: p.query } : {}),
    ...(p.folderId ? { folderId: p.folderId } : {}),
    ...(p.cursor ? { cursor: p.cursor } : {}),
    // Both of these the Knowledge page passes (liftoff-react, useKnowledge.ts).
    // `entityType` is what lets a source with more than one kind of thing in it
    // be asked for the right kind — a help centre's articles as against its
    // collections — and without it those sources answer for whatever they
    // consider default, which for some of them is nothing.
    ...(p.entityType ? { entityType: p.entityType } : {}),
    ...(p.mimeTypes ? { mimeTypes: p.mimeTypes } : {}),
  });
  return {
    files: result.results.map((r) => ({
      externalId: r.id,
      title: r.title,
      url: r.url,
      // The kind the source says it is, passed straight back and straight on to
      // the add. Six kinds reach here (article, document, page, folder,
      // collection, url) and they are not interchangeable: an article from a
      // help centre is read over a different call from a file in Drive.
      contentType: r.contentType,
      // The provider's own type, which decides how the text is read out of the
      // file. Passed back on the add so the row stores it.
      mimeType: typeof r.metadata?.['mimeType'] === 'string' ? r.metadata['mimeType'] : null,
    })),
    nextCursor: result.nextCursor ?? null,
    // The connector cannot enumerate this, which is NOT the same as the account
    // holding none of it. Both arrive as an empty list, and a model told only
    // "no files" would tell the person their Drive is empty.
    ...(result.unsupported ? { cannotList: true } : {}),
  };
}

/**
 * Add one file from a connected app to the library, the way the Knowledge page's
 * file picker does: the row carries the connector and the file's own id, so the
 * text is read out of the file itself rather than fetched from a URL.
 *
 * `mimeType` is stored on the row. Every item created so far carries `metadata`
 * `{}`, so extraction has been inferring the type from the response and a
 * google_drive fallback. Storing what the provider said is not a fix for a
 * failure today; it is the difference between extraction being right by
 * construction and right by fallback.
 */
export async function addKnowledgeFile(
  actor: Actor,
  p: { connectorId: string; externalId: string; title: string; contentType?: string; sourceUrl?: string; mimeType?: string },
) {
  requirePermission(actor, 'knowledge:write');
  const title = p.title.trim();
  if (title.length === 0 || title.length > 500) {
    return { refused: 'validation', message: 'The title must be between 1 and 500 characters.' } as KnowledgeRefusal;
  }
  if (!p.connectorId.trim() || !p.externalId.trim()) {
    return { refused: 'validation', message: 'connectorId and externalId are both required; knowledge_browse gives both.' } as KnowledgeRefusal;
  }
  const connectors = await listConnectorsForTenant(actor.tenantId, actor.accountId);
  const connector = connectors.find((c) => c.id === p.connectorId.trim());
  // A file cannot be read through a connection the workspace does not have
  // connected, and the person is looking at the same list: refusing here says
  // so, where importing anyway would create another row that never reads.
  if (!connector || !showsAsConnected(connector.status)) {
    return {
      refused: 'validation',
      message: 'That app is not connected in this workspace. connections_list shows what is connected.',
    } as KnowledgeRefusal;
  }
  // The page takes the kind from browse and passes it through unchanged
  // (KnowledgePage.tsx: `r.contentType ?? 'document'`). Forcing everything to
  // document or folder here would have stored a Zendesk, Intercom, Confluence
  // or OneNote article as a document — and those four are read over the article
  // call, which is handed this very field. A knowledge library is not only
  // Drive files, and the tool that adds to it cannot be.
  const contentType = KNOWLEDGE_CONTENT_TYPES.has(p.contentType ?? '')
    ? (p.contentType as ContentType)
    : 'document';
  const item = await knowledgeService.createItem(actor.tenantId, {
    title,
    connectorId: p.connectorId.trim(),
    ...(connector.type ? { connectorType: connector.type } : {}),
    externalId: p.externalId.trim(),
    contentType,
    ...(p.sourceUrl ? { sourceUrl: p.sourceUrl } : {}),
    ...(p.mimeType ? { metadata: { mimeType: p.mimeType } } : {}),
    importMode: 'file_select',
    // A container holds no text of its own; everything else is read after it is
    // added, which puts the row on the retry budget rather than ending it. Both
    // container kinds, exactly as POST /api/knowledge/batch decides it.
    extractionStatus: CONTAINER_CONTENT_TYPES.has(contentType) ? 'none' : 'pending',
  });
  writeAudit(actor, 'knowledge.item_added', {
    resourceType: 'knowledge_item',
    resourceId: item.id,
    newState: { id: item.id, contentType: item.contentType, title: item.title, connectorType: item.connectorType, importMode: item.importMode },
  });
  return { added: true, item: itemView(item) };
}

/**
 * Read one library entry again, in place.
 *
 * The entry that prompted this had synced and failed to extract, and the only
 * thing on offer was adding a second copy of the same file. A re-read changes
 * nothing when the file is genuinely unreadable — the reason on the row says so,
 * and it comes back here — and fixes the case where the failure was transient,
 * without leaving a second dead entry behind either way.
 */
export async function resyncKnowledgeItem(actor: Actor, p: { id: string }) {
  requirePermission(actor, 'knowledge:write');
  const item = await knowledgeService.getById(actor.tenantId, p.id);
  if (!item) {
    return { refused: 'validation', message: 'No library entry with that id.' } as KnowledgeRefusal;
  }
  if (!item.connectorId || !item.externalId) {
    return {
      refused: 'validation',
      message: 'That entry is a URL rather than a file from a connected app, so there is nothing to read again.',
    } as KnowledgeRefusal;
  }
  const outcome = await knowledgeService.extractAndPersistItem(item);
  const after = await knowledgeService.getById(actor.tenantId, p.id);
  writeAudit(actor, 'knowledge.item_resynced', {
    resourceType: 'knowledge_item',
    resourceId: item.id,
    previousState: { extractionStatus: item.extractionStatus, syncError: item.syncError },
    newState: { extractionStatus: after?.extractionStatus ?? null, syncError: after?.syncError ?? null },
  });
  return {
    read: outcome.ok,
    item: after ? itemView(after) : itemView(item),
  };
}
