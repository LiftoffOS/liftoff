// googledocs overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

//
// Write-provenance declarations below are in CANONICAL shape. Nothing here
// translates input or output, so the canonical names ARE Composio's: `idArgs`
// name arguments off each tool's input_parameters, and `returnsIds` paths are
// read against `data` off its output_parameters.
//
// The id key is NOT uniform across this toolkit, nor across its versions.
// insert_text and replace_all_text return `document_id`; copy, insert_table
// and, on `latest`, get_document and both creates return `documentId`. Each
// declaration is read from its own tool's answer at the version the runtime
// calls rather than from the one above it, and the creates normalise to
// `document_id` so one shape and one provenance path hold for every version.
import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

/** The id of a document a create tool made, wherever Composio put it.
 *
 *  The answer depends on the TOOLKIT VERSION the call names, and the runtime
 *  dispatches every toolkit at `latest`. On `latest`
 *  both create tools answer with the Docs API's own object, `documentId` in
 *  camelCase at the top level, and carry no `document_id` and no
 *  `response_data` at all. The unversioned default, which is also the schema
 *  the registry shows when no version is named, declares `document_id`
 *  nullable beside a `response_data` object where the same `documentId`
 *  sits. Reading only the default's two places throws
 *  `canonical_shape_violation` on every create the runtime makes, after the
 *  document has been created, so an agent would report the write as failed
 *  and escalate. Read all three; a response carrying none is the
 *  genuine violation the shape exists to catch. */
function withDocumentId(r: unknown): unknown {
  const resp = (r ?? {}) as {
    document_id?: string | null;
    documentId?: string | null;
    response_data?: { documentId?: string } | null;
  };
  const document_id = [resp.document_id, resp.documentId, resp.response_data?.documentId]
    .find((v): v is string => typeof v === 'string' && v.length > 0);
  return document_id === undefined ? resp : { ...resp, document_id };
}

export const GOOGLEDOCS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GOOGLEDOCS_SEARCH_DOCUMENTS: {
    stableName: 'search_documents',
    categoryOverrides: ["read"],
    returnsIds: [{ entityType: 'document', path: 'documents[].id' }],
  },
  GOOGLEDOCS_GET_DOCUMENT_BY_ID: {
    stableName: 'get_document',
    categoryOverrides: ["read"],
    // Two paths for the two toolkit versions: the default wraps the Docs
    // API answer in `response_data`, `latest` returns it as the data itself.
    // A path that resolves to nothing records nothing, so both can stand.
    returnsIds: [
      { entityType: 'document', path: 'response_data.documentId' },
      { entityType: 'document', path: 'documentId' },
    ],
  },
  GOOGLEDOCS_CREATE_DOCUMENT: {
    stableName: 'create_document',
    categoryOverrides: ["write"],
    returnsIds: [{ entityType: 'document', path: 'document_id' }],
    translateOutput: withDocumentId,
  },
  GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN: {
    stableName: 'create_document_markdown',
    categoryOverrides: ["write"],
    returnsIds: [{ entityType: 'document', path: 'document_id' }],
    translateOutput: withDocumentId,
  },
  GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN: {
    stableName: 'update_document_markdown',
    categoryOverrides: ["write"],
    idArgs: ['document_id'],
  },
  GOOGLEDOCS_INSERT_TEXT_ACTION: {
    stableName: 'insert_text',
    categoryOverrides: ["write"],
    idArgs: ['document_id'],
    returnsIds: [{ entityType: 'document', path: 'document_id' }],
  },
  GOOGLEDOCS_REPLACE_ALL_TEXT: {
    stableName: 'replace_all_text',
    categoryOverrides: ["write"],
    idArgs: ['document_id'],
    returnsIds: [{ entityType: 'document', path: 'document_id' }],
  },
  GOOGLEDOCS_COPY_DOCUMENT: {
    stableName: 'copy_document',
    categoryOverrides: ["write"],
    idArgs: ['document_id'],
    returnsIds: [{ entityType: 'document', path: 'documentId' }],
  },
  GOOGLEDOCS_INSERT_TABLE_ACTION: {
    stableName: 'insert_table',
    categoryOverrides: ["write"],
    // documentId, not document_id: this tool and copy_document are the two
    // that answer in camelCase, and this one takes it that way on the way in
    // as well. The write-pair validator caught the mismatch.
    idArgs: ['documentId'],
    returnsIds: [{ entityType: 'document', path: 'documentId' }],
  },
};

export const GOOGLEDOCS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
