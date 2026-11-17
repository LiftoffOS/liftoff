// Microsoft OneNote Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

// OneNote Notebook structure
interface OneNoteNotebook {
  id: string;
  displayName?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  isDefault?: boolean;
  isShared?: boolean;
  sectionsUrl?: string;
  sectionGroupsUrl?: string;
  createdBy?: {
    user?: {
      id?: string;
      displayName?: string;
    };
  };
  lastModifiedBy?: {
    user?: {
      id?: string;
      displayName?: string;
    };
  };
  links?: {
    oneNoteClientUrl?: { href?: string };
    oneNoteWebUrl?: { href?: string };
  };
}

// OneNote Section structure
interface OneNoteSection {
  id: string;
  displayName?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  isDefault?: boolean;
  pagesUrl?: string;
  parentNotebook?: {
    id?: string;
    displayName?: string;
  };
  parentSectionGroup?: {
    id?: string;
    displayName?: string;
  };
}

// OneNote Page structure
interface OneNotePage {
  id: string;
  title?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  level?: number;
  order?: number;
  contentUrl?: string;
  links?: {
    oneNoteClientUrl?: { href?: string };
    oneNoteWebUrl?: { href?: string };
  };
  parentSection?: {
    id?: string;
    displayName?: string;
  };
  parentNotebook?: {
    id?: string;
    displayName?: string;
  };
}

// List response
interface OneNoteListResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: (OneNoteNotebook | OneNoteSection | OneNotePage)[];
}

type OneNotePayload = OneNoteNotebook | OneNoteSection | OneNotePage | OneNoteListResponse;

const UserRefSchema = z.object({
  id: z.string().optional(),
  displayName: z.string().optional(),
});

const ParentRefSchema = z.object({
  id: z.string().optional(),
  displayName: z.string().optional(),
});

const NotebookDataSchema = z.object({
  id: z.string().describe('OneNote notebook id.'),
  displayName: z.string().optional(),
  isDefault: z.boolean().optional(),
  isShared: z.boolean().optional(),
  createdBy: UserRefSchema.optional(),
  lastModifiedBy: UserRefSchema.optional(),
  oneNoteClientUrl: z.string().optional(),
  oneNoteWebUrl: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

const SectionDataSchema = z.object({
  id: z.string().describe('OneNote section id.'),
  displayName: z.string().optional(),
  isDefault: z.boolean().optional(),
  parentNotebook: ParentRefSchema.optional(),
  parentSectionGroup: ParentRefSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

const PageDataSchema = z.object({
  id: z.string().describe('OneNote page id.'),
  title: z.string().optional(),
  level: z.number().optional(),
  order: z.number().optional(),
  contentUrl: z.string().optional(),
  oneNoteClientUrl: z.string().optional(),
  oneNoteWebUrl: z.string().optional(),
  parentSection: ParentRefSchema.optional(),
  parentNotebook: ParentRefSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

export class MicrosoftOneNoteNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_onenote';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Notebook: NotebookDataSchema,
    Section: SectionDataSchema,
    Page: PageDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const onenotePayload = payload as OneNotePayload;

    // Reactive polling — the scheduler wraps client.list('Page') output as
    // { results: [row.data, ...] }. Each row is a flat Microsoft Graph page
    // object (from GET /me/onenote/pages), so emit a Page record per row.
    if (
      onenotePayload &&
      typeof onenotePayload === 'object' &&
      'results' in onenotePayload &&
      Array.isArray((onenotePayload as { results?: unknown[] }).results)
    ) {
      const rows = (onenotePayload as { results: OneNotePage[] }).results;
      for (const row of rows) {
        if (row && typeof row === 'object' && 'id' in row && row.id) {
          records.push(this.normalizePage(row));
        }
      }
      return records;
    }

    // Handle list response
    if (this.isListResponse(onenotePayload)) {
      for (const item of onenotePayload.value) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle single item
    if (this.isNotebook(onenotePayload) || this.isSection(onenotePayload) || this.isPage(onenotePayload)) {
      records.push(this.normalizeItem(onenotePayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: OneNoteNotebook | OneNoteSection | OneNotePage): NormalizedRecord {
    if (this.isNotebook(item)) {
      return this.normalizeNotebook(item);
    }
    if (this.isSection(item)) {
      return this.normalizeSection(item);
    }
    return this.normalizePage(item as OneNotePage);
  }

  private normalizeNotebook(notebook: OneNoteNotebook): NormalizedRecord {
    return {
      entityType: 'Notebook',
      externalId: notebook.id,
      data: NotebookDataSchema.parse({
        id: notebook.id,
        displayName: notebook.displayName,
        isDefault: notebook.isDefault,
        isShared: notebook.isShared,
        createdBy: notebook.createdBy?.user ? {
          id: notebook.createdBy.user.id,
          displayName: notebook.createdBy.user.displayName,
        } : undefined,
        lastModifiedBy: notebook.lastModifiedBy?.user ? {
          id: notebook.lastModifiedBy.user.id,
          displayName: notebook.lastModifiedBy.user.displayName,
        } : undefined,
        oneNoteClientUrl: notebook.links?.oneNoteClientUrl?.href,
        oneNoteWebUrl: notebook.links?.oneNoteWebUrl?.href,
        createdAt: notebook.createdDateTime,
        modifiedAt: notebook.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_onenote',
        syncedAt: new Date(),
        version: notebook.lastModifiedDateTime ?? hashCanonicalJson(notebook),
      },
    };
  }

  private normalizeSection(section: OneNoteSection): NormalizedRecord {
    return {
      entityType: 'Section',
      externalId: section.id,
      data: SectionDataSchema.parse({
        id: section.id,
        displayName: section.displayName,
        isDefault: section.isDefault,
        parentNotebook: section.parentNotebook ? {
          id: section.parentNotebook.id,
          displayName: section.parentNotebook.displayName,
        } : undefined,
        parentSectionGroup: section.parentSectionGroup ? {
          id: section.parentSectionGroup.id,
          displayName: section.parentSectionGroup.displayName,
        } : undefined,
        createdAt: section.createdDateTime,
        modifiedAt: section.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_onenote',
        syncedAt: new Date(),
        version: section.lastModifiedDateTime ?? hashCanonicalJson(section),
      },
    };
  }

  private normalizePage(page: OneNotePage): NormalizedRecord {
    return {
      entityType: 'Page',
      externalId: page.id,
      data: PageDataSchema.parse({
        id: page.id,
        title: page.title,
        level: page.level,
        order: page.order,
        contentUrl: page.contentUrl,
        oneNoteClientUrl: page.links?.oneNoteClientUrl?.href,
        oneNoteWebUrl: page.links?.oneNoteWebUrl?.href,
        parentSection: page.parentSection ? {
          id: page.parentSection.id,
          displayName: page.parentSection.displayName,
        } : undefined,
        parentNotebook: page.parentNotebook ? {
          id: page.parentNotebook.id,
          displayName: page.parentNotebook.displayName,
        } : undefined,
        createdAt: page.createdDateTime,
        modifiedAt: page.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_onenote',
        syncedAt: new Date(),
        version: page.lastModifiedDateTime ?? hashCanonicalJson(page),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as OneNotePayload;
    if (this.isListResponse(r)) return 'ItemList';
    if (this.isNotebook(r)) return 'Notebook';
    if (this.isSection(r)) return 'Section';
    if (this.isPage(r)) return 'Page';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as OneNotePayload;
    if (this.isNotebook(r) || this.isSection(r) || this.isPage(r)) return r.id;
    return '';
  }

  extractVersion(_record: unknown): string | undefined {
    return undefined;
  }

  private isListResponse(payload: OneNotePayload): payload is OneNoteListResponse {
    return 'value' in payload && Array.isArray(payload.value);
  }

  private isNotebook(payload: OneNotePayload): payload is OneNoteNotebook {
    return 'id' in payload && 'displayName' in payload && 'sectionsUrl' in payload;
  }

  private isSection(payload: OneNotePayload): payload is OneNoteSection {
    return 'id' in payload && 'displayName' in payload && 'pagesUrl' in payload;
  }

  private isPage(payload: OneNotePayload): payload is OneNotePage {
    return 'id' in payload && 'title' in payload && 'contentUrl' in payload;
  }
}
