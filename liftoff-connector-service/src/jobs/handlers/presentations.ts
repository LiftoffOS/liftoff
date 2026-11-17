import { logger } from '../../infra/logging.js';
import { credentialService } from '../../credentials/service.js';
import { makeGoogleApiFetcher } from '../../credentials/google-fetcher.js';
import { placeInDriveFolder } from './drive-placement.js';

export interface SlideInput {
  title?: string;
  content?: string;
  bullets?: string[];
  table?: { headers: string[]; rows: string[][] };
  notes?: string;
}

export interface CreateFromTemplateBody {
  templateFileId?: string;
  name: string;
  title: string;
  subtitle?: string;
  slides: SlideInput[];
  /** Drive folder id to place the deck in; absent means Drive's default
   *  location. Applied as one move after creation — see drive-placement.ts. */
  parentFolderId?: string;
}

export interface PresentationResult {
  presentationId: string;
  name: string;
  webViewUrl: string;
}

// Google Slides API caps objectId at 50 chars. Full UUIDs (36 chars) plus
// prefixes like "slide-title-shape-0-" exceed that. Use 8 hex chars instead —
// 32 bits is sufficient to avoid collisions within a single presentation.
function uid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

export async function handleCreateFromTemplate(input: {
  connectorId: string;
  tenantId: string;
  body: CreateFromTemplateBody;
}): Promise<PresentationResult> {
  const { connectorId, tenantId, body } = input;

  // Re-fetch credentials at execution time — never passed in via input JSONB.
  const creds = await credentialService.getCredentials(tenantId, connectorId);

  const gFetch = makeGoogleApiFetcher(tenantId, connectorId, creds);

  // 1. Acquire a new presentation and its geometry.
  //    With templateFileId: copy the Drive file to inherit its theme + page size.
  //    Without: create a blank presentation via the Slides API.
  let newPresentationId: string;
  let presentationName: string;
  let slideW: number;
  let slideH: number;
  let originalSlideIds: string[];

  if (body.templateFileId) {
    const copyResp = await gFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(body.templateFileId)}/copy`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: body.name }),
      },
    );
    if (!copyResp.ok) throw new Error(`Template copy failed: ${copyResp.status}`);
    const copyData = await copyResp.json() as { id: string; name: string };
    newPresentationId = copyData.id;
    presentationName = copyData.name;

    const presResp = await gFetch(
      `https://slides.googleapis.com/v1/presentations/${newPresentationId}`,
    );
    if (!presResp.ok) {
      await gFetch(`https://www.googleapis.com/drive/v3/files/${newPresentationId}`, { method: 'DELETE' }).catch(() => {});
      throw new Error(`Failed to fetch copied presentation: ${presResp.status}`);
    }
    const presData = await presResp.json() as {
      pageSize: { width: { magnitude: number }; height: { magnitude: number } };
      slides: Array<{ objectId: string }>;
    };
    slideW = presData.pageSize.width.magnitude;
    slideH = presData.pageSize.height.magnitude;
    originalSlideIds = (presData.slides ?? []).map((s) => s.objectId);
  } else {
    const createResp = await gFetch(
      'https://slides.googleapis.com/v1/presentations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: body.name }),
      },
    );
    if (!createResp.ok) throw new Error(`Blank presentation creation failed: ${createResp.status}`);
    const createData = await createResp.json() as {
      presentationId: string;
      title: string;
      pageSize: { width: { magnitude: number }; height: { magnitude: number } };
      slides: Array<{ objectId: string }>;
    };
    newPresentationId = createData.presentationId;
    presentationName = createData.title;
    slideW = createData.pageSize.width.magnitude;
    slideH = createData.pageSize.height.magnitude;
    originalSlideIds = (createData.slides ?? []).map((s) => s.objectId);
  }

  const cleanupOrphan = async () => {
    try {
      await gFetch(
        `https://www.googleapis.com/drive/v3/files/${newPresentationId}`,
        { method: 'DELETE' },
      );
    } catch (cleanupErr) {
      logger.warn({ cleanupErr }, 'create-from-template: orphan cleanup failed');
    }
  };

  // 3. Compute layout constants (all values in EMU)
  const MARGIN = Math.round(slideW * 0.05);
  const CONTENT_W = slideW - MARGIN * 2;
  const TITLE_H = Math.round(slideH * 0.16);
  const BODY_Y = Math.round(slideH * 0.22);
  const BODY_H = slideH - BODY_Y - MARGIN;

  // 4. Build batchUpdate requests
  const requests: Record<string, unknown>[] = [];

  const addTextBox = (
    slideId: string,
    shapeId: string,
    x: number,
    y: number,
    width: number,
    height: number,
    text: string,
  ) => {
    requests.push({
      createShape: {
        objectId: shapeId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: width, unit: 'EMU' },
            height: { magnitude: height, unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: x,
            translateY: y,
            unit: 'EMU',
          },
        },
      },
    });
    requests.push({
      insertText: {
        objectId: shapeId,
        insertionIndex: 0,
        text,
      },
    });
  };

  // Title slide
  const titleSlideId = `slide-title-${uid()}`;
  requests.push({
    createSlide: {
      objectId: titleSlideId,
      insertionIndex: 0,
      slideLayoutReference: { predefinedLayout: 'BLANK' },
    },
  });
  const titleShapeId = `title-shape-${uid()}`;
  addTextBox(
    titleSlideId,
    titleShapeId,
    MARGIN,
    Math.round(slideH * 0.3),
    CONTENT_W,
    Math.round(TITLE_H * 1.5),
    body.title,
  );
  if (body.subtitle) {
    const subtitleShapeId = `sub-shape-${uid()}`;
    addTextBox(
      titleSlideId,
      subtitleShapeId,
      MARGIN,
      Math.round(slideH * 0.3) + Math.round(TITLE_H * 1.5) + MARGIN,
      CONTENT_W,
      TITLE_H,
      body.subtitle,
    );
  }

  // Content slides
  for (let i = 0; i < body.slides.length; i++) {
    const slide = body.slides[i];
    const slideId = `sld-${i}-${uid()}`;
    requests.push({
      createSlide: {
        objectId: slideId,
        insertionIndex: i + 1,
        slideLayoutReference: { predefinedLayout: 'BLANK' },
      },
    });

    if (slide.title) {
      const slideTitleId = `stsh-${i}-${uid()}`;
      addTextBox(slideId, slideTitleId, MARGIN, MARGIN, CONTENT_W, TITLE_H, slide.title);
    }

    if (slide.bullets && slide.bullets.length > 0) {
      const bodyShapeId = `body-${i}-${uid()}`;
      requests.push({
        createShape: {
          objectId: bodyShapeId,
          shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: slideId,
            size: {
              width: { magnitude: CONTENT_W, unit: 'EMU' },
              height: { magnitude: BODY_H, unit: 'EMU' },
            },
            transform: {
              scaleX: 1,
              scaleY: 1,
              translateX: MARGIN,
              translateY: BODY_Y,
              unit: 'EMU',
            },
          },
        },
      });
      requests.push({
        insertText: {
          objectId: bodyShapeId,
          insertionIndex: 0,
          text: slide.bullets.join('\n'),
        },
      });
      requests.push({
        createParagraphBullets: {
          objectId: bodyShapeId,
          textRange: { type: 'ALL' },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
    } else if (slide.content) {
      const contentShapeId = `cnt-${i}-${uid()}`;
      addTextBox(slideId, contentShapeId, MARGIN, BODY_Y, CONTENT_W, BODY_H, slide.content);
    } else if (slide.table) {
      const tableId = `tbl-${i}-${uid()}`;
      const { headers, rows } = slide.table;
      requests.push({
        createTable: {
          objectId: tableId,
          elementProperties: {
            pageObjectId: slideId,
            size: {
              width: { magnitude: CONTENT_W, unit: 'EMU' },
              height: { magnitude: BODY_H, unit: 'EMU' },
            },
            transform: {
              scaleX: 1,
              scaleY: 1,
              translateX: MARGIN,
              translateY: BODY_Y,
              unit: 'EMU',
            },
          },
          rows: 1 + rows.length,
          columns: headers.length,
        },
      });
      for (let j = 0; j < headers.length; j++) {
        requests.push({
          insertText: {
            objectId: tableId,
            cellLocation: { rowIndex: 0, columnIndex: j },
            insertionIndex: 0,
            text: headers[j],
          },
        });
      }
      for (let r = 0; r < rows.length; r++) {
        for (let j = 0; j < rows[r].length; j++) {
          requests.push({
            insertText: {
              objectId: tableId,
              cellLocation: { rowIndex: r + 1, columnIndex: j },
              insertionIndex: 0,
              text: rows[r][j],
            },
          });
        }
      }
    }
  }

  // Delete original template slides
  for (const id of originalSlideIds) {
    requests.push({ deleteObject: { objectId: id } });
  }

  // 5. Single batchUpdate
  const batchResp = await gFetch(
    `https://slides.googleapis.com/v1/presentations/${newPresentationId}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    },
  );
  if (!batchResp.ok) {
    const errText = await batchResp.text();
    logger.error({ errText }, 'create-from-template: batchUpdate failed');
    await cleanupOrphan();
    throw new Error(`Presentation population failed: ${batchResp.status}`);
  }

  // 6. Phase 2: insert speaker notes (requires a second batchUpdate)
  const slidesWithNotes = body.slides
    .map((s, i) => ({ slideIndex: i + 1, notes: s.notes }))
    .filter((s): s is { slideIndex: number; notes: string } => Boolean(s.notes));

  if (slidesWithNotes.length > 0) {
    const updatedPresResp = await gFetch(
      `https://slides.googleapis.com/v1/presentations/${newPresentationId}`,
    );
    if (updatedPresResp.ok) {
      const updatedPres = await updatedPresResp.json() as {
        slides: Array<{
          notesPage?: {
            pageElements?: Array<{
              objectId: string;
              shape?: { placeholder?: { type: string } };
            }>;
          };
        }>;
      };
      const notesRequests: Record<string, unknown>[] = [];
      for (const { slideIndex, notes } of slidesWithNotes) {
        const slideData = updatedPres.slides[slideIndex];
        if (!slideData?.notesPage?.pageElements) continue;
        const bodyEl = slideData.notesPage.pageElements.find(
          (el) => el.shape?.placeholder?.type === 'BODY',
        );
        if (!bodyEl) continue;
        notesRequests.push({
          insertText: { objectId: bodyEl.objectId, insertionIndex: 0, text: notes },
        });
      }
      if (notesRequests.length > 0) {
        const notesResp = await gFetch(
          `https://slides.googleapis.com/v1/presentations/${newPresentationId}:batchUpdate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: notesRequests }),
          },
        );
        if (!notesResp.ok) {
          const notesErrText = await notesResp.text();
          logger.warn({ notesErrText }, 'create-from-template: notes batchUpdate failed — slide content is intact, notes skipped');
        }
      }
    } else {
      logger.warn('create-from-template: could not fetch updated presentation to insert notes — notes skipped');
    }
  }

  await placeInDriveFolder(gFetch, newPresentationId, body.parentFolderId, 'presentation');

  return {
    presentationId: newPresentationId,
    name: presentationName,
    webViewUrl: `https://docs.google.com/presentation/d/${newPresentationId}/edit`,
  };
}

export async function handleCopyAndReplace(input: {
  connectorId: string;
  tenantId: string;
  presentationId: string;
  body: { name?: string; replacements?: Array<{ find: string; replace: string }> };
}): Promise<PresentationResult> {
  const { connectorId, tenantId, presentationId, body } = input;

  // Re-fetch credentials at execution time — never passed in via input JSONB.
  const creds = await credentialService.getCredentials(tenantId, connectorId);

  const gFetch = makeGoogleApiFetcher(tenantId, connectorId, creds);

  const copyResp = await gFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(presentationId)}/copy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: body.name ?? 'Copy' }),
    },
  );
  if (!copyResp.ok) throw new Error(`Copy failed: ${copyResp.status}`);
  const copyData = await copyResp.json() as { id: string; name: string };

  if (body.replacements?.length) {
    const requests = body.replacements.map((r: { find: string; replace: string }) => ({
      replaceAllText: {
        replaceText: r.replace,
        pageObjectIds: [],
        containsText: { text: r.find, matchCase: false },
      },
    }));
    const batchResp = await gFetch(
      `https://slides.googleapis.com/v1/presentations/${copyData.id}:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      },
    );
    if (!batchResp.ok) throw new Error(`Text replacement failed after copy: ${batchResp.status}`);
  }

  return {
    presentationId: copyData.id,
    name: copyData.name,
    webViewUrl: `https://docs.google.com/presentation/d/${copyData.id}/edit`,
  };
}
