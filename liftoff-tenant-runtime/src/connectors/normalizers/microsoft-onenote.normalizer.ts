// Microsoft OneNote Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { ConnectorNormalizer, NormalizedRecord } from './types';
import { hashCanonicalJson } from './idempotency';

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

export class MicrosoftOneNoteNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_onenote';

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];
    const onenotePayload = payload as OneNotePayload;

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
      data: {
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
      },
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
      data: {
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
      },
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
      data: {
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
      },
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
