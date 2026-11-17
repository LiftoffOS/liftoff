/**
 * Document Tools MCP Registration
 *
 * Registers per-manifest document tools (list_files, read_document,
 * find_in_document, generate_xlsx, generate_docx, edit_document,
 * read_presentation, generate_pptx, edit_presentation) for every
 * cloud_storage connector manifest (Google Drive, OneDrive, SharePoint,
 * Dropbox, Box).
 *
 * Pattern: tool() calls produce SdkMcpToolDefinition entries that are
 * pushed onto the mcpTools array.
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { isToolErrorCode, type ConnectorManifest, type ToolErrorCode } from '@liftoffos/connector-types';
import type { StandardToolContext } from '../tools/standard-tool-handler';
import type { ModelTool } from './mcp-server';
import * as handlers from './document-tool-handlers';
import { formatToolErrorEnvelope } from './tool-error-envelope';
import { hostsGoogleNativeDocs, hostsGoogleNativeSlides } from './google-native-hosts';

// Strip webViewUrl from file results returned to the agent — the UI file
// component already surfaces the link, so the model doesn't need it and won't
// repeat it verbatim in its response text.
function toAgentText(result: unknown): string {
  // Classified connector-service failure (carries a tool-error `code`, e.g. from
  // connectorRestError) → render the uniform TOOL_ERROR envelope so the model
  // reads the same contract as every other tool error, with the ACTUAL cause
  // (not_found / vendor_unavailable / auth_expired) instead of a blanket auth error.
  if (
    result && typeof result === 'object'
    && 'code' in result && 'error' in result && isToolErrorCode((result as { code: unknown }).code)
  ) {
    const e = result as { code: ToolErrorCode; message?: string; error?: string };
    return formatToolErrorEnvelope({ message: e.message ?? e.error ?? 'connector call failed', code: e.code });
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const { webViewUrl: _url, ...rest } = result as Record<string, unknown>;
    return JSON.stringify(rest);
  }
  return JSON.stringify(result);
}

// ── Cloud storage connector types ──────────────────────────────────────────────
const CLOUD_STORAGE_TYPES = new Set([
  'google_drive',
  'microsoft_onedrive',
  'microsoft_sharepoint',
  'dropbox',
  'box',
  'google_slides',
  'google_docs',
]);

// ── registerDocumentTools ──────────────────────────────────────────────────────

export function registerDocumentTools(
  mcpTools: ReturnType<typeof tool>[],
  manifests: ConnectorManifest[],
  ctx: StandardToolContext & { invocationId?: string },
  modelTools?: ModelTool[],
): void {
  for (const manifest of manifests) {
    if (!CLOUD_STORAGE_TYPES.has(manifest.connectorType)) continue;

    const alias = manifest.alias.replace(/[^a-zA-Z0-9_-]/g, '_');

    // ── {alias}__list_files ──────────────────────────────────────────────────
    const listFilesName = `${alias}__list_files`;
    const listFilesDesc = `List files in the "${manifest.displayName}" cloud storage. Optionally filter by path, query, or MIME type.`;
    mcpTools.push(
      tool(
        listFilesName,
        listFilesDesc,
        {
          path: z.string().optional(),
          query: z.string().optional(),
          mimeTypes: z.array(z.string()).optional(),
          recursive: z.boolean().optional().default(false),
          maxResults: z.number().optional().default(50),
        },
        async (args) => {
          const result = await handlers.listFiles(args, manifest, ctx);
          return {
            content: [{ type: 'text' as const, text: toAgentText(result) }],
            isError: 'error' in result,
          };
        },
      ),
    );
    modelTools?.push({ name: listFilesName, description: listFilesDesc, categories: ['read'] });

    // ── {alias}__read_document ───────────────────────────────────────────────
    const readDocName = `${alias}__read_document`;
    const readDocDesc = `Read and extract text from a document in "${manifest.displayName}". Supports PDF, DOCX, PPTX, and plain text. Returns the document text and filename.`;
    mcpTools.push(
      tool(
        readDocName,
        readDocDesc,
        {
          fileId: z.string(),
        },
        async (args) => {
          const result = await handlers.readDocument(args, manifest, ctx);
          return {
            content: [{ type: 'text' as const, text: toAgentText(result) }],
            isError: 'error' in result,
          };
        },
      ),
    );
    modelTools?.push({ name: readDocName, description: readDocDesc, categories: ['read'] });

    // ── {alias}__find_in_document ────────────────────────────────────────────
    const findInDocName = `${alias}__find_in_document`;
    const findInDocDesc = `Search for a specific phrase or clause within a document in "${manifest.displayName}". Case-insensitive, whitespace-tolerant exact match. Returns all occurrences with surrounding context.`;
    mcpTools.push(
      tool(
        findInDocName,
        findInDocDesc,
        {
          fileId: z.string(),
          query: z.string(),
          maxResults: z.number().optional().default(20),
          contextChars: z.number().optional().default(80),
        },
        async (args) => {
          const result = await handlers.findInDocument(args, manifest, ctx);
          return {
            content: [{ type: 'text' as const, text: toAgentText(result) }],
            isError: 'error' in result,
          };
        },
      ),
    );
    modelTools?.push({ name: findInDocName, description: findInDocDesc, categories: ['read'] });

    // ── {alias}__generate_xlsx ───────────────────────────────────────────────
    const genXlsxName = `${alias}__generate_xlsx`;
    const genXlsxDesc = `Generate an Excel (.xlsx) workbook and upload it to "${manifest.displayName}". Supports multiple sheets with column headers and rows.`;
    mcpTools.push(
      tool(
        genXlsxName,
        genXlsxDesc,
        {
          baseName: z.string().describe('Base filename without extension (e.g. "Credit Agreement Summary")'),
          sheets: z.array(
            z.object({
              name: z.string(),
              columns: z.array(z.string()),
              rows: z.array(z.array(z.string())),
              columnFormats: z.array(z.string()).optional().describe('Format hint per column (parallel to columns array). Values: text, yes_no, date, monetary_amount, bulleted_list, percentage, tag, number. Used to normalise cell values after extraction.'),
            }),
          ),
          outputPath: z.string().optional().describe('Destination folder. Google Drive and Slides take the folder ID (it is sent as the Drive `parents` value); OneDrive and SharePoint take a folder PATH. Omit for the root.'),
        },
        async (args) => {
          const result = await handlers.generateXlsx(args, manifest, ctx);
          return {
            content: [{ type: 'text' as const, text: toAgentText(result) }],
            isError: 'error' in result,
          };
        },
      ),
    );
    modelTools?.push({ name: genXlsxName, description: genXlsxDesc, categories: ['write'] });

    // ── {alias}__generate_docx ───────────────────────────────────────────────
    const genDocxName = `${alias}__generate_docx`;
    // Dispatch on what the connector can HOST, not on its type. Drive hosts
    // native Docs and Slides, so a Drive-bound team gets the native document —
    // the one that opens in Docs, has no extension, and cards through the
    // connector-native door — rather than a .docx pushed into Drive as a
    // foreign file. The read side made this same move for presentations
    // (`pick the presentation reader by file type, not connector type`); the
    // write side had kept the type check. Both native routes on
    // connector-service take any connector whose credentials reach the Google
    // APIs, so the only thing this changes is which door a Drive team reaches.
    const isGoogleDocs = hostsGoogleNativeDocs(manifest.connectorType);
    const genDocxDesc = isGoogleDocs
      ? `Create a rich Google Docs document in "${manifest.displayName}" with headings, paragraphs, bullet lists, and tables. Returns a link to the created document. Do NOT include links in your prose — the document card is shown automatically.`
      : `Generate a Word (.docx) document and upload it to "${manifest.displayName}". Use this when asked to draft, create, or produce a document. Returns a download URL. Do NOT include download links in your prose — the download card is shown automatically.`;
    mcpTools.push(
      tool(
        genDocxName,
        genDocxDesc,
        {
          title: z.string().describe('Document title — used as the document name and rendered as a centered heading.'),
          landscape: z.boolean().optional().default(false).describe('Set to true for landscape orientation (Word/DOCX only — ignored for Google Docs).'),
          sections: z.array(
            z.object({
              heading: z.string().optional().describe('Section heading text. Do NOT include numbering — numbering is applied automatically.'),
              level: z.number().int().min(1).max(3).optional().describe('Heading level: 1, 2, or 3. Always use level 1 before introducing level 2. Defaults to 1.'),
              content: z.string().optional().describe('Prose content. Lines starting with -, •, or * are rendered as bullets. Separate paragraphs with newlines.'),
              pageBreak: z.boolean().optional().describe('Set to true to start this section on a new page (e.g. signature pages).'),
              table: z
                .object({
                  headers: z.array(z.string()).describe('Column header labels.'),
                  rows: z.array(z.array(z.string())).describe('Array of rows; each row must have the same number of cells as headers.'),
                })
                .optional(),
            }),
          ),
          outputPath: z.string().optional().describe('Destination folder. Google Drive and Slides take the folder ID (it is sent as the Drive `parents` value); OneDrive and SharePoint take a folder PATH. Omit for the root.'),
        },
        async (args) => {
          const result = isGoogleDocs
            ? await handlers.generateGoogleDoc(args, manifest, ctx)
            : await handlers.generateDocx(args, manifest, ctx);
          return {
            content: [{ type: 'text' as const, text: toAgentText(result) }],
            isError: 'error' in result,
          };
        },
      ),
    );
    modelTools?.push({ name: genDocxName, description: genDocxDesc, categories: ['write'] });

    // ── {alias}__edit_document ───────────────────────────────────────────────
    const editDocName = `${alias}__edit_document`;
    const editDocDesc = `Apply tracked changes to an existing Word document in "${manifest.displayName}". Each edit is a precise find/replace; changes are wrapped in OOXML tracked-change markup so the user can Accept or Reject each one. Use read_document first to get the exact text.`;
    mcpTools.push(
      tool(
        editDocName,
        editDocDesc,
        {
          doc_id: z.string().describe('File ID of the .docx to edit (from list_files or a prior generate_docx result).'),
          edits: z.array(
            z.object({
              find: z.string().describe('Exact substring to replace — keep as short as possible, just the words being changed.'),
              replace: z.string().describe('Replacement text. Empty string = pure deletion.'),
              context_before: z.string().describe('~40 chars immediately before the find text, to disambiguate.'),
              context_after: z.string().describe('~40 chars immediately after the find text, to disambiguate.'),
              reason: z.string().optional().describe('Short explanation shown to the user on the review card.'),
            }),
          ),
          outputPath: z.string().optional().describe('Destination folder. Google Drive and Slides take the folder ID (it is sent as the Drive `parents` value); OneDrive and SharePoint take a folder PATH. Omit for the root.'),
        },
        async (args) => {
          const result = await handlers.editDocument(args, manifest, ctx);
          return {
            content: [{ type: 'text' as const, text: toAgentText(result) }],
            isError: 'error' in result,
          };
        },
      ),
    );
    modelTools?.push({ name: editDocName, description: editDocDesc, categories: ['write'] });

    // ── {alias}__read_presentation ───────────────────────────────────────────
    const readPresName = `${alias}__read_presentation`;
    const readPresDesc = `Read a presentation file (PPTX or Google Slides) in "${manifest.displayName}" and return structured slide data including titles, body text, tables, and speaker notes.`;
    mcpTools.push(
      tool(
        readPresName,
        readPresDesc,
        {
          fileId: z.string().describe('The file ID of the presentation in the connector'),
        },
        async (args) => {
          try {
            const result = await handlers.readPresentation({ fileId: args.fileId }, manifest, ctx);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error reading presentation: ${String(err)}` }], isError: true };
          }
        },
      ),
    );
    modelTools?.push({ name: readPresName, description: readPresDesc, categories: ['read'] });

    // ── {alias}__generate_pptx ──────────────────────────────────────────────
    const genPptxName = `${alias}__generate_pptx`;
    const isGoogleSlides = hostsGoogleNativeSlides(manifest.connectorType);
    // The description promises the format the handler will produce. A model
    // told it makes PPTX and handed a Slides deck keeps asking for PPTX.
    const genPptxDesc = isGoogleSlides
      ? `Create a native Google Slides presentation in "${manifest.displayName}". Returns a link to the created deck. Do NOT include links in your prose — the deck card is shown automatically.`
      : `Generate a PowerPoint presentation (PPTX) and upload it to "${manifest.displayName}".`;
    mcpTools.push(
      tool(
        genPptxName,
        genPptxDesc,
        {
          title: z.string().describe('Title for the presentation'),
          subtitle: z.string().optional().describe('Optional subtitle for the title slide'),
          slides: z.array(z.object({
            title: z.string().optional(),
            bullets: z.array(z.string()).optional(),
            content: z.string().optional(),
            table: z.object({
              headers: z.array(z.string()),
              rows: z.array(z.array(z.string())),
            }).optional(),
            notes: z.string().optional(),
          })).describe('Slides to include'),
          outputPath: z.string().optional().describe('Destination folder. Google Drive and Slides take the folder ID (it is sent as the Drive `parents` value); OneDrive and SharePoint take a folder PATH. Omit for the root.'),
          templateFileId: z.string().optional().describe(
            'Google Slides file ID to use as template. If provided, copies the file to inherit its theme; if omitted, creates a blank presentation.',
          ),
        },
        async (args) => {
          const result = isGoogleSlides
            ? await handlers.generatePresentationSlides(args as Parameters<typeof handlers.generatePresentationSlides>[0], manifest, ctx)
            : await handlers.generatePptx(args, manifest, ctx);
          return {
            content: [{ type: 'text' as const, text: toAgentText(result) }],
            isError: 'error' in result,
          };
        },
      ),
    );
    modelTools?.push({ name: genPptxName, description: genPptxDesc, categories: ['write'] });

    // ── {alias}__edit_presentation ───────────────────────────────────────────
    const editPresName = `${alias}__edit_presentation`;
    const editPresDesc = `Edit an existing presentation in "${manifest.displayName}" by finding and replacing text across all slides. For PPTX files, produces a new _v2.pptx file. For Google Slides, copies the template and applies replacements.`;
    mcpTools.push(
      tool(
        editPresName,
        editPresDesc,
        {
          fileId: z.string().describe('The file ID of the presentation to edit'),
          name: z.string().optional().describe('Base name for the output file'),
          replacements: z.array(z.object({
            find: z.string(),
            replace: z.string(),
          })).describe('Text replacements to apply'),
          outputPath: z.string().optional().describe('Destination folder. Google Drive and Slides take the folder ID (it is sent as the Drive `parents` value); OneDrive and SharePoint take a folder PATH. Omit for the root.'),
        },
        async (args) => {
          const result = await handlers.editPresentation(args, manifest, ctx);
          return {
            content: [{ type: 'text' as const, text: toAgentText(result) }],
            isError: 'error' in result,
          };
        },
      ),
    );
    modelTools?.push({ name: editPresName, description: editPresDesc, categories: ['write'] });
  }
}
