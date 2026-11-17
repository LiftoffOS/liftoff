// Microsoft SharePoint Connector Normalizer
// Per Section 12: Connector ingestion - normalizes Microsoft Graph API responses

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

// SharePoint Site structure
interface SharePointSite {
  id: string;
  displayName?: string;
  name?: string;
  description?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  root?: Record<string, any>;
  siteCollection?: {
    hostname?: string;
  };
}

// SharePoint List structure
interface SharePointList {
  id: string;
  displayName?: string;
  name?: string;
  description?: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  list?: {
    contentTypesEnabled?: boolean;
    hidden?: boolean;
    template?: string;
  };
  siteId?: string;
}

// SharePoint List Item structure
interface SharePointListItem {
  id: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  eTag?: string;
  fields?: Record<string, any>;
  createdBy?: {
    user?: {
      email?: string;
      displayName?: string;
    };
  };
  lastModifiedBy?: {
    user?: {
      email?: string;
      displayName?: string;
    };
  };
  siteId?: string;
  listId?: string;
}

// SharePoint Drive Item structure
interface SharePointDriveItem {
  id: string;
  name?: string;
  description?: string;
  webUrl?: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  eTag?: string;
  file?: {
    mimeType?: string;
    hashes?: {
      sha1Hash?: string;
    };
  };
  folder?: {
    childCount?: number;
  };
  parentReference?: {
    id?: string;
    path?: string;
    driveId?: string;
    siteId?: string;
  };
  createdBy?: {
    user?: {
      email?: string;
      displayName?: string;
    };
  };
  lastModifiedBy?: {
    user?: {
      email?: string;
      displayName?: string;
    };
  };
}

// List response
interface SharePointListResponse {
  '@odata.context'?: string;
  '@odata.nextLink'?: string;
  value: (SharePointSite | SharePointList | SharePointListItem | SharePointDriveItem)[];
}

// Polling-path wrapper: the scheduler hands the normalizer { results: [row.data, ...] },
// where each row.data is a raw Graph driveItem (files only — folders are filtered
// out by the client before this point).
interface SharePointResultsWrapper {
  results: SharePointDriveItem[];
}

type SharePointPayload = SharePointSite | SharePointList | SharePointListItem | SharePointDriveItem | SharePointListResponse;

const SpUserRefSchema = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
});

const SiteDataSchema = z.object({
  id: z.string().describe('SharePoint site id.'),
  displayName: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  webUrl: z.string().optional(),
  hostname: z.string().optional(),
  isRoot: z.boolean(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

const ListDataSchema = z.object({
  id: z.string().describe('SharePoint list id (composite siteId:listId when present).'),
  displayName: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  webUrl: z.string().optional(),
  template: z.string().optional(),
  isHidden: z.boolean().optional(),
  contentTypesEnabled: z.boolean().optional(),
  siteId: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

const ListItemDataSchema = z.object({
  id: z.string().describe('SharePoint list-item id (composite siteId:listId:itemId when present).'),
  webUrl: z.string().optional(),
  fields: z.record(z.unknown()).optional(),
  createdBy: SpUserRefSchema.optional(),
  lastModifiedBy: SpUserRefSchema.optional(),
  siteId: z.string().optional(),
  listId: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});

const FileDataSchema = z.object({
  id: z.string().describe('SharePoint drive-item id (composite siteId:itemId when present).'),
  name: z.string().optional(),
  description: z.string().optional(),
  webUrl: z.string().optional(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  isFolder: z.boolean(),
  childCount: z.number().optional(),
  parentId: z.string().optional(),
  parentPath: z.string().optional(),
  driveId: z.string().optional(),
  siteId: z.string().optional(),
  sha1Hash: z.string().optional(),
  createdBy: SpUserRefSchema.optional(),
  lastModifiedBy: SpUserRefSchema.optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional().describe('Last modification timestamp.'),
});

const DocumentDataSchema = z.object({
  id: z.string().describe('SharePoint document (driveItem) id.'),
  name: z.string().optional().describe('File name including extension.'),
  webUrl: z.string().optional().describe('Direct link to open the document.'),
  size: z.number().optional().describe('File size in bytes.'),
  mimeType: z.string().optional().describe('MIME type from the file facet.'),
  parentPath: z.string().optional().describe('parentReference.path of the containing folder.'),
  driveId: z.string().optional(),
  siteId: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional().describe('Last modification timestamp — used as the sync version.'),
});

export class MicrosoftSharePointNormalizer implements ConnectorNormalizer {
  connectorType = 'microsoft_sharepoint';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Site: SiteDataSchema,
    List: ListDataSchema,
    ListItem: ListItemDataSchema,
    File: FileDataSchema,
    Folder: FileDataSchema,
    Document: DocumentDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const records: NormalizedRecord[] = [];

    // Polling path: scheduler wraps page rows as { results: [driveItem, ...] }.
    // Each driveItem is a file (folders are filtered by the client) → Document.
    if (this.isResultsWrapper(payload)) {
      for (const item of payload.results) {
        records.push(this.normalizeDocument(item));
      }
      return records;
    }

    const spPayload = payload as SharePointPayload;

    // Handle list response
    if (this.isListResponse(spPayload)) {
      for (const item of spPayload.value) {
        records.push(this.normalizeItem(item));
      }
      return records;
    }

    // Handle single item
    if (this.isSite(spPayload) || this.isList(spPayload) || this.isListItem(spPayload) || this.isDriveItem(spPayload)) {
      records.push(this.normalizeItem(spPayload));
      return records;
    }

    return records;
  }

  private normalizeItem(item: SharePointSite | SharePointList | SharePointListItem | SharePointDriveItem): NormalizedRecord {
    if (this.isSite(item)) {
      return this.normalizeSite(item);
    }
    if (this.isList(item)) {
      return this.normalizeList(item);
    }
    if (this.isListItem(item)) {
      return this.normalizeListItem(item);
    }
    return this.normalizeDriveItem(item as SharePointDriveItem);
  }

  private normalizeSite(site: SharePointSite): NormalizedRecord {
    return {
      entityType: 'Site',
      externalId: site.id,
      data: SiteDataSchema.parse({
        id: site.id,
        displayName: site.displayName,
        name: site.name,
        description: site.description,
        webUrl: site.webUrl,
        hostname: site.siteCollection?.hostname,
        isRoot: !!site.root,
        createdAt: site.createdDateTime,
        modifiedAt: site.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_sharepoint',
        syncedAt: new Date(),
        version: site.lastModifiedDateTime ?? hashCanonicalJson(site),
      },
    };
  }

  private normalizeList(list: SharePointList): NormalizedRecord {
    return {
      entityType: 'List',
      externalId: list.siteId ? `${list.siteId}:${list.id}` : list.id,
      data: ListDataSchema.parse({
        id: list.siteId ? `${list.siteId}:${list.id}` : list.id,
        displayName: list.displayName,
        name: list.name,
        description: list.description,
        webUrl: list.webUrl,
        template: list.list?.template,
        isHidden: list.list?.hidden,
        contentTypesEnabled: list.list?.contentTypesEnabled,
        siteId: list.siteId,
        createdAt: list.createdDateTime,
        modifiedAt: list.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_sharepoint',
        syncedAt: new Date(),
        version: list.lastModifiedDateTime ?? hashCanonicalJson(list),
      },
    };
  }

  private normalizeListItem(item: SharePointListItem): NormalizedRecord {
    const externalId = item.siteId && item.listId
      ? `${item.siteId}:${item.listId}:${item.id}`
      : item.id;

    return {
      entityType: 'ListItem',
      externalId,
      data: ListItemDataSchema.parse({
        id: externalId,
        webUrl: item.webUrl,
        fields: item.fields,
        createdBy: item.createdBy?.user ? {
          email: item.createdBy.user.email,
          displayName: item.createdBy.user.displayName,
        } : undefined,
        lastModifiedBy: item.lastModifiedBy?.user ? {
          email: item.lastModifiedBy.user.email,
          displayName: item.lastModifiedBy.user.displayName,
        } : undefined,
        siteId: item.siteId,
        listId: item.listId,
        createdAt: item.createdDateTime,
        modifiedAt: item.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_sharepoint',
        syncedAt: new Date(),
        version: item.eTag ?? hashCanonicalJson(item),
      },
    };
  }

  private normalizeDriveItem(item: SharePointDriveItem): NormalizedRecord {
    const siteId = item.parentReference?.siteId;
    const externalId = siteId ? `${siteId}:${item.id}` : item.id;

    return {
      entityType: item.folder ? 'Folder' : 'File',
      externalId,
      data: FileDataSchema.parse({
        id: externalId,
        name: item.name,
        description: item.description,
        webUrl: item.webUrl,
        size: item.size,
        mimeType: item.file?.mimeType,
        isFolder: !!item.folder,
        childCount: item.folder?.childCount,
        parentId: item.parentReference?.id,
        parentPath: item.parentReference?.path,
        driveId: item.parentReference?.driveId,
        siteId,
        sha1Hash: item.file?.hashes?.sha1Hash,
        createdBy: item.createdBy?.user ? {
          email: item.createdBy.user.email,
          displayName: item.createdBy.user.displayName,
        } : undefined,
        lastModifiedBy: item.lastModifiedBy?.user ? {
          email: item.lastModifiedBy.user.email,
          displayName: item.lastModifiedBy.user.displayName,
        } : undefined,
        createdAt: item.createdDateTime,
        modifiedAt: item.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_sharepoint',
        syncedAt: new Date(),
        version: item.eTag ?? hashCanonicalJson(item),
      },
    };
  }

  // Polling driveItem → Document. modifiedAt is the version so the scheduler can
  // dedup re-seen files (the search endpoint has no $filter for incremental).
  private normalizeDocument(item: SharePointDriveItem): NormalizedRecord {
    const siteId = item.parentReference?.siteId;
    const externalId = siteId ? `${siteId}:${item.id}` : item.id;

    return {
      entityType: 'Document',
      externalId,
      data: DocumentDataSchema.parse({
        id: externalId,
        name: item.name,
        webUrl: item.webUrl,
        size: item.size,
        mimeType: item.file?.mimeType,
        parentPath: item.parentReference?.path,
        driveId: item.parentReference?.driveId,
        siteId,
        createdAt: item.createdDateTime,
        modifiedAt: item.lastModifiedDateTime,
      }),
      metadata: {
        source: 'microsoft_sharepoint',
        syncedAt: new Date(),
        version: item.lastModifiedDateTime ?? item.eTag ?? hashCanonicalJson(item),
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as SharePointPayload;
    if (this.isListResponse(r)) return 'ItemList';
    if (this.isSite(r)) return 'Site';
    if (this.isList(r)) return 'List';
    if (this.isListItem(r)) return 'ListItem';
    if (this.isDriveItem(r)) return (r as SharePointDriveItem).folder ? 'Folder' : 'File';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as SharePointPayload;
    if (this.isSite(r) || this.isList(r) || this.isListItem(r) || this.isDriveItem(r)) return r.id;
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as SharePointPayload;
    if (this.isListItem(r) || this.isDriveItem(r)) return (r as SharePointListItem | SharePointDriveItem).eTag;
    return undefined;
  }

  private isResultsWrapper(payload: unknown): payload is SharePointResultsWrapper {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'results' in payload &&
      Array.isArray((payload as { results: unknown }).results)
    );
  }

  private isListResponse(payload: SharePointPayload): payload is SharePointListResponse {
    return 'value' in payload && Array.isArray(payload.value);
  }

  private isSite(payload: SharePointPayload): payload is SharePointSite {
    return 'id' in payload && 'webUrl' in payload && ('siteCollection' in payload || 'root' in payload);
  }

  private isList(payload: SharePointPayload): payload is SharePointList {
    return 'id' in payload && 'list' in payload;
  }

  private isListItem(payload: SharePointPayload): payload is SharePointListItem {
    return 'id' in payload && 'fields' in payload;
  }

  private isDriveItem(payload: SharePointPayload): payload is SharePointDriveItem {
    return 'id' in payload && 'name' in payload && ('file' in payload || 'folder' in payload);
  }
}
