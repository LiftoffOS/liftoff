import { logger } from '../../infra/logging.js';
import { credentialService } from '../../credentials/service.js';
import { makeGoogleApiFetcher } from '../../credentials/google-fetcher.js';
import { placeInDriveFolder } from './drive-placement.js';

export interface GoogleDocSection {
  heading?: string;
  level?: number;
  content?: string;
  pageBreak?: boolean;
  table?: { headers: string[]; rows: string[][] };
}

export interface CreateGoogleDocBody {
  title: string;
  sections: GoogleDocSection[];
  /** Drive folder id to place the document in; absent means Drive's default
   *  location. Applied as one move after creation — see drive-placement.ts. */
  parentFolderId?: string;
}

export interface GoogleDocResult {
  documentId: string;
  name: string;
  webViewUrl: string;
}

export async function handleCreateGoogleDoc(input: {
  connectorId: string;
  tenantId: string;
  body: CreateGoogleDocBody;
}): Promise<GoogleDocResult> {
  const { connectorId, tenantId, body } = input;

  const creds = await credentialService.getCredentials(tenantId, connectorId);

  const gFetch = makeGoogleApiFetcher(tenantId, connectorId, creds);

  // 1. Create blank document — title is set here, not via batchUpdate.
  const createResp = await gFetch('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: body.title }),
  });
  if (!createResp.ok) throw new Error(`Failed to create document: ${createResp.status}`);
  const createData = await createResp.json() as { documentId: string };
  const documentId = createData.documentId;

  const cleanupOrphan = async () => {
    await gFetch(`https://www.googleapis.com/drive/v3/files/${documentId}`, { method: 'DELETE' })
      .catch(err => logger.warn({ err }, 'create-google-doc: orphan cleanup failed'));
  };

  // 2. Build batchUpdate requests.
  //
  // Strategy: insert content at a tracked cursor position that starts at 1
  // (the beginning of the blank document body, before its single trailing \n).
  // Each insertion advances the cursor by the number of characters inserted.
  // Paragraph style and text style ranges are computed from the cursor at
  // insert time, so they stay correct as content grows.
  //
  // Tables are rendered as pipe-delimited monospace text (two-pass native
  // table insertion requires re-reading the document for cell character
  // positions, which we skip here to keep this a single batchUpdate).
  type Request = Record<string, unknown>;
  const requests: Request[] = [];
  let cursor = 1;

  const insertText = (text: string) => {
    requests.push({ insertText: { location: { index: cursor }, text } });
    return text.length;
  };

  const applyParaStyle = (start: number, end: number, namedStyleType: string, extra?: Record<string, unknown>) => {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: end },
        paragraphStyle: { namedStyleType, ...extra },
        fields: `namedStyleType${extra ? ',' + Object.keys(extra).join(',') : ''}`,
      },
    });
  };

  const applyTextStyle = (start: number, end: number, style: Record<string, unknown>, fields: string) => {
    requests.push({ updateTextStyle: { range: { startIndex: start, endIndex: end }, textStyle: style, fields } });
  };

  // Title paragraph
  const titleText = `${body.title}\n`;
  const titleStart = cursor;
  cursor += insertText(titleText);
  applyParaStyle(titleStart, cursor, 'TITLE', { alignment: 'CENTER' });
  applyTextStyle(titleStart, cursor - 1, { bold: true }, 'bold');

  for (const section of body.sections) {
    if (section.pageBreak) {
      // Insert a paragraph with pageBreakBefore — simplest safe approach.
      const pbText = '\n';
      const pbStart = cursor;
      cursor += insertText(pbText);
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: pbStart, endIndex: cursor },
          paragraphStyle: { pageBreakBefore: true },
          fields: 'pageBreakBefore',
        },
      });
    }

    if (section.heading) {
      const level = Math.max(1, Math.min(3, section.level ?? 1));
      const headingText = `${section.heading}\n`;
      const headingStart = cursor;
      cursor += insertText(headingText);
      applyParaStyle(headingStart, cursor, `HEADING_${level}`);
    }

    if (section.table) {
      const { headers, rows } = section.table;
      const sepRow = '|' + headers.map(() => '---|').join('');
      const lines = [
        '| ' + headers.join(' | ') + ' |',
        sepRow,
        ...rows.map(row => '| ' + row.join(' | ') + ' |'),
        '',
      ];
      const tableText = lines.join('\n');
      const tableStart = cursor;
      cursor += insertText(tableText);
      applyTextStyle(
        tableStart,
        cursor,
        { weightedFontFamily: { fontFamily: 'Courier New' }, fontSize: { magnitude: 10, unit: 'PT' } },
        'weightedFontFamily,fontSize',
      );
    }

    if (section.content) {
      for (const line of section.content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          cursor += insertText('\n');
          continue;
        }
        const bulletMatch = trimmed.match(/^[-•*]\s+(.+)/);
        if (bulletMatch) {
          const bulletText = `${bulletMatch[1]}\n`;
          const bulletStart = cursor;
          cursor += insertText(bulletText);
          requests.push({
            createParagraphBullets: {
              range: { startIndex: bulletStart, endIndex: cursor },
              bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
            },
          });
        } else {
          cursor += insertText(`${trimmed}\n`);
        }
      }
    }
  }

  // 3. Single batchUpdate — all insertions and style applications.
  if (requests.length > 0) {
    const batchResp = await gFetch(
      `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      },
    );
    if (!batchResp.ok) {
      const errText = await batchResp.text();
      logger.error({ errText }, 'create-google-doc: batchUpdate failed');
      await cleanupOrphan();
      throw new Error(`Document population failed: ${batchResp.status}`);
    }
  }

  await placeInDriveFolder(gFetch, documentId, body.parentFolderId, 'document');

  return {
    documentId,
    name: body.title,
    webViewUrl: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export interface CopyAndEditDocumentResult {
  documentId: string;
  name: string;
  webViewUrl: string;
  /** One entry per requested edit, in order, with what it actually changed. */
  replacements: Array<{ find: string; occurrencesChanged: number }>;
  /** Edits that matched nothing. Present so a caller cannot read "job done" as
   *  "every edit applied". */
  unmatched: string[];
}

/**
 * Copy a Google Doc and apply find/replace edits to the copy.
 *
 * The native counterpart to the runtime's editDocument, which downloads a
 * .docx, applies tracked changes and hands back a redlined file. That path
 * needs bytes, and a composio_managed connector has none to give — Composio
 * signs requests server-side and never releases the token, so nothing can
 * download the source.
 *
 * This produces a real edited document instead, the same way copy-and-replace
 * already does for Slides: copy, edit the copy, return a link. Two honest
 * differences from the .docx path, both visible in the result rather than
 * papered over:
 *
 *   - No tracked changes. The Docs API cannot create suggestions, so the edits
 *     are applied outright. The original is untouched because we edit a copy.
 *   - `replaceAllText` matches every occurrence of the search text, so the
 *     `context_before` / `context_after` an OOXML redline uses to disambiguate
 *     one instance have no equivalent. The per-edit occurrence counts come
 *     back so the caller can see when an edit hit more places than intended,
 *     and `unmatched` names the edits that hit nothing at all.
 */
export async function handleCopyAndEditDocument(input: {
  connectorId: string;
  tenantId: string;
  documentId: string;
  body: { name?: string; edits?: Array<{ find: string; replace: string }> };
}): Promise<CopyAndEditDocumentResult> {
  const { connectorId, tenantId, documentId, body } = input;

  // Re-fetch credentials at execution time — never passed in via input JSONB.
  const creds = await credentialService.getCredentials(tenantId, connectorId);
  const gFetch = makeGoogleApiFetcher(tenantId, connectorId, creds);

  const copyResp = await gFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}/copy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: body.name ?? 'Copy' }),
    },
  );
  if (!copyResp.ok) throw new Error(`Copy failed: ${copyResp.status}`);
  const copyData = (await copyResp.json()) as { id: string; name: string };

  const edits = body.edits ?? [];
  const replacements: Array<{ find: string; occurrencesChanged: number }> = [];

  if (edits.length > 0) {
    const requests = edits.map((e) => ({
      replaceAllText: {
        replaceText: e.replace,
        containsText: { text: e.find, matchCase: true },
      },
    }));
    const batchResp = await gFetch(
      `https://docs.googleapis.com/v1/documents/${copyData.id}:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      },
    );
    if (!batchResp.ok) throw new Error(`Edits failed after copy: ${batchResp.status}`);
    const batch = (await batchResp.json()) as {
      replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }>;
    };
    edits.forEach((e, i) => {
      replacements.push({
        find: e.find,
        occurrencesChanged: batch.replies?.[i]?.replaceAllText?.occurrencesChanged ?? 0,
      });
    });
  }

  return {
    documentId: copyData.id,
    name: copyData.name,
    webViewUrl: `https://docs.google.com/document/d/${copyData.id}/edit`,
    replacements,
    unmatched: replacements.filter((r) => r.occurrencesChanged === 0).map((r) => r.find),
  };
}
