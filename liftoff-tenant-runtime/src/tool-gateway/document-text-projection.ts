// A document read returns the document, not its typography.
//
// Google's `documents.get` answers with a styling tree: paragraph elements,
// list glyph definitions, indent magnitudes in points, and a `namedStyles`
// block defining every heading level. None of it is content, and its SIZE does
// not depend on content — an empty document comes back at about 13 KB.
//
// What that costs: a step that reads a digest with `get_document`, declaring
// (correctly) that it must read the whole thing because it is about to append
// to it, is handed some 13,000 characters to convey ONE newline. The
// step-to-step budget is 8,192, so the value cannot be passed on; the agent has
// no workspace to park it in; and the runtime does the right thing and refuses
// rather than hand the step a summary of a document it had to read whole. The
// run dies seconds in.
//
// The wrapping is larger than the budget on its own, so that step could never
// have succeeded — not for a big document, and not for an empty one.
//
// This runs as an output guardrail because that is the ONE place every path to
// the model passes through (see output-guardrails.ts). Projecting in the step
// loop would have fixed the step and left the same 13 KB going into chat turns
// and autonomous runs.

/** Google Docs structural keys that carry presentation and never content. */
const PRESENTATION_KEYS = new Set([
  'namedStyles', 'lists', 'documentStyle', 'suggestedDocumentStyleChanges',
  'suggestedNamedStylesChanges', 'inlineObjects', 'positionedObjects',
  'namedRanges', 'revisionId', 'suggestionsViewMode',
]);

/** A Google Docs `documents.get` response, by shape rather than by connector
 *  name: the same body arrives under several aliases and through both the
 *  Composio route and a direct one. */
function isGoogleDocsDocument(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const body = o.body as { content?: unknown } | undefined;
  return Boolean(body && typeof body === 'object' && Array.isArray(body.content));
}

/** The text of one `documents.get` body, with paragraph breaks kept.
 *
 *  Walks `textRun.content` in document order. Table cells carry their own
 *  nested content arrays, so the walk is recursive rather than a flat scan over
 *  the top level — a digest written as a table would otherwise read as empty. */
function documentText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) documentText(child, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const textRun = o.textRun as { content?: unknown } | undefined;
  if (textRun && typeof textRun.content === 'string') {
    out.push(textRun.content);
    return;
  }
  // Only the containers that hold content. Walking every value would pull in
  // the style blocks this projection exists to drop.
  for (const key of ['content', 'elements', 'paragraph', 'table', 'tableRows', 'tableCells', 'body']) {
    if (key in o) documentText(o[key], out);
  }
}

export interface ProjectedDocument {
  documentId?: string;
  title?: string;
  /** The document's text. Empty string for an empty document, which is a FACT
   *  about the document and must not be confused with a failed read. */
  text: string;
  /** How many characters of presentation were dropped, so an operator can see
   *  the projection working and a reader knows nothing of substance was cut. */
  presentationCharsDropped: number;
}

/**
 * Project a document read down to its text, or return the value unchanged.
 *
 * Returns the input untouched for anything that is not a documents.get body,
 * so a tool this does not understand is never altered.
 */
export function projectDocumentText(output: unknown): unknown {
  if (!isGoogleDocsDocument(output)) return output;
  const o = output as Record<string, unknown>;
  const parts: string[] = [];
  documentText(o.body, parts);
  const before = JSON.stringify(output)?.length ?? 0;

  const projected: ProjectedDocument = {
    ...(typeof o.documentId === 'string' ? { documentId: o.documentId } : {}),
    ...(typeof o.title === 'string' ? { title: o.title } : {}),
    text: parts.join(''),
    presentationCharsDropped: 0,
  };
  // Anything the caller sent that is neither content nor presentation is kept:
  // dropping a field this file has not heard of would be a silent data loss,
  // and the point here is the style blocks, which are named.
  for (const [k, v] of Object.entries(o)) {
    if (k === 'body' || k === 'documentId' || k === 'title') continue;
    if (PRESENTATION_KEYS.has(k)) continue;
    (projected as unknown as Record<string, unknown>)[k] = v;
  }
  projected.presentationCharsDropped = Math.max(0, before - (JSON.stringify(projected)?.length ?? 0));
  return projected;
}
